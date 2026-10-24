/** Pure reconciliation identities, canonical submissions and exact mutation coverage. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import type {
  ImplementationTermDelta,
  ImplementationTermDisposition,
} from '../assurance/implementation-term-dispositions.ts';
import { IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST } from './implementation-reconciliation-policy.ts';
import {
  semanticFileSubjectId,
  isSemanticSubjectId,
} from './semantic-ledger.ts';
import type {
  ActualMutation,
  ChangedRange,
  MutationDisposition,
  PlannedMutation,
  ReconciliationVerdict,
} from './semantic-reconciliation.ts';
import {
  resolvePathRole,
  type PathRoleRegistry,
} from '../source/path-role-registry.ts';

export type ReconciledLedgerProjection = Readonly<{
  schemaVersion: 1;
  kind: 'reconciled-semantic-ledger-projection';
  entryIds: readonly string[];
  paths: readonly string[];
  indexDigest: string;
}>;
export type ReconciliationIntent = Readonly<{
  summary: string;
  explicitPaths: readonly string[];
}>;
export type ReconciliationWhyEvidence = Readonly<{
  pathIdentity: Readonly<{ utf8: string | null }>;
  protectedInvariant: string;
}>;
const CURRENT_REQUIREMENT_KIND =
  'implementation-reconciliation-requirement' as const;
export const RECONCILIATION_REPORT_KIND = 'implementation-reconciliation';
export const REPORT_SCHEMA = 'workflow.implementation-reconciliation-report.v2';
export const CURRENT_REQUIREMENT_ID = 'implementation-reconciliation';
const MAX_TEXT_BYTES = 16_384;
const MAX_MUTATIONS = 4_096;
const MAX_RANGES = 16_384;
const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DISPOSITIONS = new Set<MutationDisposition>([
  'existing-subject-changed',
  'new-subject',
  'subject-deleted',
  'subject-moved',
  'non-semantic-change',
  'generated-output',
  'vendored-or-external',
]);

export { IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST } from './implementation-reconciliation-policy.ts';

export type ImplementationPlannedMutation = PlannedMutation &
  Readonly<{ path: string }>;

export type ImplementationReconciliationRequirement = Readonly<{
  schemaVersion: 1;
  kind: 'implementation-reconciliation-requirement';
  changeId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  policyDigest: typeof IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST;
  plannedMutations: readonly ImplementationPlannedMutation[];
}>;

export type ImplementationReconciliationRequest = Readonly<{
  schemaVersion: 2;
  kind: 'implementation-reconciliation';
  changeId: string;
  sessionId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  requirementId: typeof CURRENT_REQUIREMENT_ID;
  requirementDigest: string;
  investigationManifestDigest: string;
  implementationTargetDigest: string;
  plannedMutations: readonly ImplementationPlannedMutation[];
  changedRanges: readonly ChangedRange[];
  termDelta: ImplementationTermDelta;
  termDispositions: readonly ImplementationTermDisposition[];
  actualMutations: readonly ActualMutation[];
}>;

export type ImplementationReconciliationRecord = Readonly<{
  reportId: string;
  request: ImplementationReconciliationRequest;
  verdict: ReconciliationVerdict;
  ledgerProjection: ReconciledLedgerProjection | null;
}>;

export type CurrentImplementationReconciliationRequirement = Readonly<{
  requirementId: typeof CURRENT_REQUIREMENT_ID;
  requirementDigest: string;
  investigationManifestDigest: string;
  requirement: ImplementationReconciliationRequirement;
}>;

/**
 * Build the current v3 planning requirement directly from Manifest-domain WHY
 * overlays.
 */
export function buildImplementationReconciliationRequirement<
  Intent extends ReconciliationIntent,
>(input: {
  changeId: string;
  baseline: { head: string; tree: string };
  intent: Intent;
  whyOverlays: readonly ReconciliationWhyEvidence[];
}): ImplementationReconciliationRequirement {
  const whyByPath = new Map<string, string>();
  for (const overlay of input.whyOverlays) {
    if (overlay.pathIdentity.utf8 === null) {
      throw reconciliationInvalid(
        'Implementation reconciliation requires UTF-8 planning paths.',
      );
    }
    const plannedPath = normalizeExactRepositoryPath(overlay.pathIdentity.utf8);
    if (whyByPath.has(plannedPath)) {
      throw reconciliationInvalid(
        `Implementation reconciliation received duplicate WHY evidence for ${plannedPath}.`,
      );
    }
    whyByPath.set(plannedPath, overlay.protectedInvariant);
  }
  return buildImplementationReconciliationPayload(input, whyByPath);
}

function buildImplementationReconciliationPayload(
  input: {
    changeId: string;
    baseline: { head: string; tree: string };
    intent: ReconciliationIntent;
  },
  whyByPath: ReadonlyMap<string, string>,
): ImplementationReconciliationRequirement {
  const changeId = assertBoundedText(input.changeId, 'change ID', 512);
  const baseline = assertBaseline(input.baseline);
  const explicitPaths = canonicalStrings(
    input.intent.explicitPaths.map(normalizeExactRepositoryPath),
    'planned paths',
  );
  const summary = assertBoundedText(
    input.intent.summary,
    'planned mutation summary',
    MAX_TEXT_BYTES,
  );
  const plannedMutations = explicitPaths.map(
    (plannedPath): ImplementationPlannedMutation => {
      const invariant = whyByPath.get(plannedPath);
      return Object.freeze({
        subjectId: semanticFileSubjectId(plannedPath),
        path: plannedPath,
        intendedChange: summary,
        invariantsToPreserve: Object.freeze(
          invariant === undefined ? [] : [invariant],
        ),
      });
    },
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'implementation-reconciliation-requirement',
    changeId,
    baseline,
    policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
    plannedMutations: Object.freeze(plannedMutations),
  });
}

export function readCurrentRequirementPayload(
  value: unknown,
): ImplementationReconciliationRequirement {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'baseline',
      'policyDigest',
      'plannedMutations',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== CURRENT_REQUIREMENT_KIND ||
    typeof value.changeId !== 'string' ||
    value.policyDigest !== IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST ||
    !Array.isArray(value.plannedMutations)
  ) {
    throw reconciliationInvalid(
      'The current implementation reconciliation requirement body is invalid.',
    );
  }
  const plannedMutations = canonicalPlannedMutations(value.plannedMutations);
  return deepFreeze({
    schemaVersion: 1,
    kind: CURRENT_REQUIREMENT_KIND,
    changeId: assertBoundedText(value.changeId, 'change ID', 512),
    baseline: assertBaseline(value.baseline),
    policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
    plannedMutations,
  });
}

export function productionSourcePath(
  candidatePath: string,
  registry: PathRoleRegistry | null,
): boolean {
  const normalized = normalizeExactRepositoryPath(candidatePath);
  if (
    normalized.startsWith('docs/') ||
    normalized.startsWith('openspec/changes/') ||
    normalized.startsWith('workflow/semantic-ledger/') ||
    normalized.includes('/test/') ||
    normalized.startsWith('scripts/')
  ) {
    return false;
  }
  if (registry !== null) {
    const resolution = resolvePathRole(registry, normalized);
    if (resolution.registered) {
      if (resolution.role === 'verification-infrastructure') return false;
      return true;
    }
  }
  return (
    normalized.startsWith('apps/') ||
    /^packages\/[^/]+\/src\//.test(normalized) ||
    normalized.startsWith('packages/workflow-engine/bootstrap/')
  );
}

export function assertReconciliationRequest(
  value: unknown,
): ImplementationReconciliationRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'sessionId',
      'baseline',
      'requirementId',
      'requirementDigest',
      'investigationManifestDigest',
      'implementationTargetDigest',
      'plannedMutations',
      'changedRanges',
      'termDelta',
      'termDispositions',
      'actualMutations',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'implementation-reconciliation' ||
    typeof value.changeId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    value.requirementId !== CURRENT_REQUIREMENT_ID ||
    typeof value.requirementDigest !== 'string' ||
    !DIGEST.test(value.requirementDigest) ||
    typeof value.investigationManifestDigest !== 'string' ||
    !DIGEST.test(value.investigationManifestDigest) ||
    typeof value.implementationTargetDigest !== 'string' ||
    !DIGEST.test(value.implementationTargetDigest) ||
    !Array.isArray(value.plannedMutations) ||
    !Array.isArray(value.changedRanges) ||
    !isRecord(value.termDelta) ||
    !Array.isArray(value.termDispositions) ||
    !Array.isArray(value.actualMutations)
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation submission is malformed.',
    );
  }
  return deepFreeze({
    schemaVersion: 2,
    kind: 'implementation-reconciliation',
    changeId: value.changeId,
    sessionId: value.sessionId,
    baseline: assertBaseline(value.baseline),
    requirementId: CURRENT_REQUIREMENT_ID,
    requirementDigest: value.requirementDigest,
    investigationManifestDigest: value.investigationManifestDigest,
    implementationTargetDigest: value.implementationTargetDigest,
    plannedMutations: canonicalPlannedMutations(value.plannedMutations),
    changedRanges: canonicalChangedRanges(value.changedRanges),
    termDelta: deepFreeze(
      structuredClone(value.termDelta) as ImplementationTermDelta,
    ),
    termDispositions: deepFreeze(
      structuredClone(
        value.termDispositions,
      ) as ImplementationTermDisposition[],
    ),
    actualMutations: canonicalActualMutations(value.actualMutations),
  });
}

export function assertEngineOwnedRequestFields(
  expected: ImplementationReconciliationRequest,
  submitted: ImplementationReconciliationRequest,
): void {
  const withoutActual = (request: ImplementationReconciliationRequest) => ({
    ...request,
    actualMutations: [],
    termDispositions: [],
  });
  if (
    canonicalJson(withoutActual(expected)) !==
    canonicalJson(withoutActual(submitted))
  ) {
    throw workflowError(
      'IMPLEMENTATION_RECONCILIATION_STALE',
      'Implementation reconciliation engine-owned bindings are stale or caller-modified.',
      ExitCode.staleState,
    );
  }
}

export function assertActualMutationCoverage(
  planned: readonly ImplementationPlannedMutation[],
  changedRanges: readonly ChangedRange[],
  actual: readonly ActualMutation[],
): void {
  const changedKeys = new Set(changedRanges.map(rangeKey));
  const observed = new Set<string>();
  const plannedBySubject = new Map(
    planned.map((entry) => [entry.subjectId, entry]),
  );
  for (const mutation of actual) {
    const claim = plannedBySubject.get(mutation.subjectId);
    if (claim !== undefined) {
      if (
        mutation.ranges.some(({ path: rangePath }) => rangePath !== claim.path)
      ) {
        throw reconciliationInvalid(
          `Mutation ${mutation.subjectId} claims a range outside its reviewed path.`,
        );
      }
      const accountedInvariants = new Set([
        ...mutation.preservedInvariants,
        ...mutation.removedInvariants,
      ]);
      if (
        claim.invariantsToPreserve.some(
          (invariant) => !accountedInvariants.has(invariant),
        )
      ) {
        throw reconciliationInvalid(
          `Mutation ${mutation.subjectId} omits a planning-time invariant.`,
        );
      }
    }
    for (const range of mutation.ranges) {
      const key = rangeKey(range);
      if (!changedKeys.has(key) || observed.has(key)) {
        throw reconciliationInvalid(
          'Implementation reconciliation ranges must partition the engine-derived production diff exactly.',
        );
      }
      observed.add(key);
    }
  }
}

function canonicalPlannedMutations(
  value: readonly unknown[],
): readonly ImplementationPlannedMutation[] {
  if (value.length > MAX_MUTATIONS) {
    throw reconciliationInvalid('Too many planned mutations.');
  }
  const mutations = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'subjectId',
        'path',
        'intendedChange',
        'invariantsToPreserve',
      ]) ||
      !isSemanticSubjectId(entry.subjectId) ||
      typeof entry.path !== 'string' ||
      typeof entry.intendedChange !== 'string' ||
      !Array.isArray(entry.invariantsToPreserve)
    ) {
      throw reconciliationInvalid('A planned mutation is malformed.');
    }
    const plannedPath = normalizeExactRepositoryPath(entry.path);
    if (entry.subjectId !== semanticFileSubjectId(plannedPath)) {
      throw reconciliationInvalid(
        'A planned file mutation has a non-canonical subject identity.',
      );
    }
    return Object.freeze({
      subjectId: entry.subjectId,
      path: plannedPath,
      intendedChange: assertBoundedText(
        entry.intendedChange,
        'intended change',
        MAX_TEXT_BYTES,
      ),
      invariantsToPreserve: Object.freeze(
        canonicalStrings(entry.invariantsToPreserve, 'planned invariants'),
      ),
    });
  });
  const canonical = [...mutations].sort((left, right) =>
    left.subjectId.localeCompare(right.subjectId),
  );
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw reconciliationInvalid(
      'Planned mutations must be sorted, unique, and canonical.',
    );
  }
  if (
    new Set(canonical.map(({ subjectId }) => subjectId)).size !==
    canonical.length
  ) {
    throw reconciliationInvalid('Planned mutation identities must be unique.');
  }
  return Object.freeze(canonical);
}

export function canonicalActualMutations(
  value: readonly unknown[],
): readonly ActualMutation[] {
  if (value.length > MAX_MUTATIONS) {
    throw reconciliationInvalid('Too many actual mutations.');
  }
  const mutations = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'subjectId',
        'disposition',
        'whatChanged',
        'whyChanged',
        'preservedInvariants',
        'removedInvariants',
        'ranges',
      ]) ||
      !isSemanticSubjectId(entry.subjectId) ||
      typeof entry.disposition !== 'string' ||
      !DISPOSITIONS.has(entry.disposition as MutationDisposition) ||
      typeof entry.whatChanged !== 'string' ||
      typeof entry.whyChanged !== 'string' ||
      !Array.isArray(entry.preservedInvariants) ||
      !Array.isArray(entry.removedInvariants) ||
      !Array.isArray(entry.ranges)
    ) {
      throw reconciliationInvalid('An actual mutation is malformed.');
    }
    return Object.freeze({
      subjectId: entry.subjectId,
      disposition: entry.disposition as MutationDisposition,
      whatChanged: assertBoundedText(
        entry.whatChanged,
        'what changed',
        MAX_TEXT_BYTES,
      ),
      whyChanged: assertBoundedText(
        entry.whyChanged,
        'why changed',
        MAX_TEXT_BYTES,
      ),
      preservedInvariants: Object.freeze(
        canonicalStrings(entry.preservedInvariants, 'preserved invariants'),
      ),
      removedInvariants: Object.freeze(
        canonicalStrings(entry.removedInvariants, 'removed invariants'),
      ),
      ranges: canonicalChangedRanges(entry.ranges),
    });
  });
  const canonical = [...mutations].sort((left, right) =>
    left.subjectId.localeCompare(right.subjectId),
  );
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw reconciliationInvalid(
      'Actual mutations must be sorted, unique, and canonical.',
    );
  }
  if (
    new Set(canonical.map(({ subjectId }) => subjectId)).size !==
    canonical.length
  ) {
    throw reconciliationInvalid('Actual mutation identities must be unique.');
  }
  return Object.freeze(canonical);
}

export function canonicalChangedRanges(
  value: readonly unknown[],
): readonly ChangedRange[] {
  if (value.length > MAX_RANGES) {
    throw reconciliationInvalid('Too many changed ranges.');
  }
  const ranges = value.map((entry) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['path', 'startLine', 'endLine']) ||
      typeof entry.path !== 'string' ||
      !Number.isSafeInteger(entry.startLine) ||
      !Number.isSafeInteger(entry.endLine) ||
      (entry.startLine as number) < 1 ||
      (entry.endLine as number) < (entry.startLine as number)
    ) {
      throw reconciliationInvalid('A changed range is malformed.');
    }
    return Object.freeze({
      path: normalizeExactRepositoryPath(entry.path),
      startLine: entry.startLine as number,
      endLine: entry.endLine as number,
    });
  });
  const canonical = [...ranges].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine,
  );
  if (new Set(canonical.map(rangeKey)).size !== canonical.length) {
    throw reconciliationInvalid('Changed ranges must be unique.');
  }
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw reconciliationInvalid('Changed ranges must be sorted and canonical.');
  }
  return Object.freeze(canonical);
}

function canonicalStrings(value: readonly unknown[], label: string): string[] {
  if (
    value.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.trim() !== entry ||
        entry.length === 0 ||
        Buffer.byteLength(entry, 'utf8') > MAX_TEXT_BYTES ||
        /\p{Cc}/u.test(entry),
    )
  ) {
    throw reconciliationInvalid(`${label} are malformed.`);
  }
  const canonical = [...(value as string[])].sort();
  if (new Set(canonical).size !== canonical.length) {
    throw reconciliationInvalid(`${label} must be unique.`);
  }
  return canonical;
}

function assertBaseline(value: unknown): { head: string; tree: string } {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['head', 'tree']) ||
    typeof value.head !== 'string' ||
    typeof value.tree !== 'string' ||
    !GIT_OBJECT.test(value.head) ||
    !GIT_OBJECT.test(value.tree) ||
    value.head.length !== value.tree.length
  ) {
    throw reconciliationInvalid(
      'Implementation reconciliation baseline is invalid.',
    );
  }
  return { head: value.head, tree: value.tree };
}

export function assertBoundedText(
  value: string,
  label: string,
  maxBytes: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    /\p{Cc}/u.test(value)
  ) {
    throw reconciliationInvalid(
      `Implementation reconciliation ${label} is invalid.`,
    );
  }
  return value;
}

function rangeKey(range: ChangedRange): string {
  return `${range.path}\0${range.startLine}\0${range.endLine}`;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function reconciliationInvalid(message: string) {
  return workflowError(
    'IMPLEMENTATION_RECONCILIATION_INVALID',
    message,
    ExitCode.verification,
  );
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export type ImplementationReconciliationGate<Inspection> = (
  inspection: Inspection,
) => ImplementationReconciliationRecord | null;
