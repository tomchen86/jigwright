/**
 * Validates and digests investigation checkpoints and scan saturation acceptance.
 *
 * Invariants:
 * - Exact keys, payload bounds, and semantic text checks retain current rejection behavior.
 * - Checkpoint and contribution digests use the same canonical payload bytes.
 *
 * Depends on: investigation domain validators, session payload types, and canonical JSON.
 * Failure modes: malformed checkpoints are accepted or equivalent contributions receive different digests.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { parseClassDisposition } from '../../modules/investigation/domain/class-disposition.ts';
import {
  INVESTIGATION_LIMITS,
  previewInvestigationTermUnion,
  type InvestigationTermKind,
} from '../../modules/investigation/domain/investigation-terms.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../session-workspace/paths.ts';
import {
  isBaseline,
  isSortedUniqueStrings,
} from './investigation-resolution-values.ts';
import {
  type GroupDispositionsPayload,
  type InvestigationCheckpointEnvelope,
  type InvestigationCheckpointKind,
  type InvestigationScanSaturationAcceptanceEnvelope,
  type MainTermsPayload,
  type WhyAnswersPayload,
} from './investigation-session-types.ts';
import {
  deepFreeze,
  DIGEST,
  hasExactKeys,
  isDigest,
  isRecord,
  isStringArray,
  sha256,
} from './investigation-store-values.ts';

const SAMPLE_AUDIT_OUTCOMES = new Set([
  'passed',
  'member-misclassified',
  'rationale-wrong',
  'type-wrong',
]);

const CHECKPOINT_ID = /^checkpoint-[0-9a-f]{64}$/;

const MAX_CHECKPOINT_BYTES = 1_048_576;

export function assertInvestigationCheckpointEnvelope(
  value: unknown,
): InvestigationCheckpointEnvelope {
  if (!isRecord(value)) {
    throw checkpointInvalid('the envelope must be a JSON object');
  }
  const keysProblem = exactKeysProblem(value, CHECKPOINT_ENVELOPE_KEYS);
  if (keysProblem !== null) {
    throw checkpointInvalid(`envelope ${keysProblem}`);
  }
  if (!isCheckpointKind(value.kind)) {
    throw checkpointInvalid(
      `kind must be the checkpointKind named by inputSchema (main-terms, group-dispositions, or why-answers), received ${JSON.stringify(value.kind)}`,
    );
  }
  if (
    !hasExactKeys(value, [...CHECKPOINT_ENVELOPE_KEYS]) ||
    value.schemaVersion !== 1 ||
    !isCheckpointKind(value.kind) ||
    typeof value.checkpointId !== 'string' ||
    !CHECKPOINT_ID.test(value.checkpointId) ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    !isDigest(value.blindManifestDigest)
  ) {
    throw checkpointInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  if (value.kind === 'main-terms') {
    assertMainTermsPayload(value.payload);
  } else if (value.kind === 'group-dispositions') {
    assertGroupDispositionsPayload(value.payload);
  } else {
    assertWhyAnswersPayload(value.payload);
  }
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw checkpointInvalid();
  }
  return deepFreeze(structuredClone(value)) as InvestigationCheckpointEnvelope;
}

export function checkpointEnvelopeDigest(
  envelope: InvestigationCheckpointEnvelope,
): string {
  return sha256(canonicalJson(assertInvestigationCheckpointEnvelope(envelope)));
}

export function checkpointContributionDigest(
  envelope: InvestigationCheckpointEnvelope,
): string {
  const validated = assertInvestigationCheckpointEnvelope(envelope);
  return sha256(
    canonicalJson({
      schemaVersion: validated.schemaVersion,
      kind: validated.kind,
      investigationId: validated.investigationId,
      changeId: validated.changeId,
      baseline: validated.baseline,
      intentDigest: validated.intentDigest,
      blindManifestDigest: validated.blindManifestDigest,
      payload: validated.payload,
    }),
  );
}

export function assertInvestigationScanSaturationAcceptanceEnvelope(
  value: unknown,
): InvestigationScanSaturationAcceptanceEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'investigationId',
      'changeId',
      'expectedRevision',
      'baseline',
      'intentDigest',
      'blindManifestDigest',
      'saturatedTermIds',
      'acknowledgeIncompleteScan',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'scan-saturation-acceptance' ||
    typeof value.investigationId !== 'string' ||
    typeof value.changeId !== 'string' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0 ||
    !isBaseline(value.baseline) ||
    !isDigest(value.intentDigest) ||
    !isDigest(value.blindManifestDigest) ||
    !isStringArray(value.saturatedTermIds) ||
    value.saturatedTermIds.length < 1 ||
    !isSortedUniqueStrings(value.saturatedTermIds) ||
    value.saturatedTermIds.some((termId) => !isDigest(termId)) ||
    value.acknowledgeIncompleteScan !== true
  ) {
    throw scanSaturationAcceptanceInvalid();
  }
  assertInvestigationId(value.investigationId);
  assertChangeId(value.changeId);
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > MAX_CHECKPOINT_BYTES) {
    throw scanSaturationAcceptanceInvalid();
  }
  return deepFreeze(
    structuredClone(value),
  ) as InvestigationScanSaturationAcceptanceEnvelope;
}

export function scanSaturationAcceptanceEnvelopeDigest(
  envelope: InvestigationScanSaturationAcceptanceEnvelope,
): string {
  return sha256(
    canonicalJson(
      assertInvestigationScanSaturationAcceptanceEnvelope(envelope),
    ),
  );
}

function assertMainTermsPayload(
  value: unknown,
): asserts value is MainTermsPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['reference', 'terms']) ||
    typeof value.reference !== 'string' ||
    value.reference.trim().length === 0 ||
    !Array.isArray(value.terms) ||
    value.terms.length < 1 ||
    value.terms.length > INVESTIGATION_LIMITS.maxMainTerms
  ) {
    throw checkpointInvalid();
  }
  for (const term of value.terms) {
    if (
      !isRecord(term) ||
      !hasExactKeys(term, [
        'kind',
        'value',
        'rationale',
        'expectedRelationship',
      ]) ||
      typeof term.kind !== 'string' ||
      typeof term.value !== 'string' ||
      typeof term.rationale !== 'string' ||
      typeof term.expectedRelationship !== 'string'
    ) {
      throw checkpointInvalid();
    }
    try {
      previewInvestigationTermUnion([
        {
          source: 'main',
          reference: value.reference,
          terms: [
            {
              kind: term.kind as InvestigationTermKind,
              value: term.value,
              rationale: term.rationale,
              expectedRelationship: term.expectedRelationship,
            },
          ],
        },
      ]);
    } catch {
      throw checkpointInvalid();
    }
  }
}

function dispositionProblem(
  item: unknown,
  index: number,
  classifications: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): string | null {
  const row = `dispositions[${index}]`;
  if (!isRecord(item)) return `${row} must be an object`;
  const keysProblem = exactKeysProblem(item, DISPOSITION_KEYS);
  if (keysProblem !== null) return `${row} ${keysProblem}`;
  if (typeof item.groupId !== 'string' || !DIGEST.test(item.groupId)) {
    return `${row}.groupId must be a groupId from work.groups`;
  }
  if (seen.has(item.groupId)) return `${row}.groupId repeats an earlier row`;
  if (
    typeof item.classification !== 'string' ||
    !classifications.has(item.classification)
  ) {
    return `${row}.classification must be one of ${[...classifications].join(', ')}, received ${JSON.stringify(item.classification)}`;
  }
  if (
    typeof item.rationale !== 'string' ||
    item.rationale.trim().length === 0
  ) {
    return `${row}.rationale must explain the classification`;
  }
  if (typeof item.author !== 'string' || item.author.trim().length === 0) {
    return `${row}.author must name who classified the group`;
  }
  return null;
}

function assertGroupDispositionsPayload(
  value: unknown,
): asserts value is GroupDispositionsPayload {
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, ['dispositions']) ||
      hasExactKeys(value, ['classes', 'dispositions']) ||
      hasExactKeys(value, ['classes', 'dispositions', 'sampleAudits'])
    ) ||
    !Array.isArray(value.dispositions) ||
    value.dispositions.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid(
      'payload must be { dispositions: [...] } with one row per group in work.groups',
    );
  }
  if (value.classes !== undefined) {
    if (
      !Array.isArray(value.classes) ||
      value.classes.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
    ) {
      throw checkpointInvalid();
    }
    if (value.sampleAudits !== undefined) {
      if (
        !Array.isArray(value.sampleAudits) ||
        value.sampleAudits.length >
          INVESTIGATION_LIMITS.maxHitDispositionWorkItems
      ) {
        throw checkpointInvalid();
      }
      for (const audit of value.sampleAudits) {
        if (
          !isRecord(audit) ||
          !hasExactKeys(audit, ['classId', 'groupId', 'outcome']) ||
          typeof audit.classId !== 'string' ||
          typeof audit.groupId !== 'string' ||
          !SAMPLE_AUDIT_OUTCOMES.has(audit.outcome as string)
        ) {
          throw checkpointInvalid();
        }
      }
    }
    const classIds = new Set<string>();
    for (const declared of value.classes) {
      // Parsed by the class contract itself rather than re-validated here, so
      // there is one definition of what a class is.
      const parsed = parseClassDisposition(declared);
      if (classIds.has(parsed.classId)) throw checkpointInvalid();
      classIds.add(parsed.classId);
    }
  }
  const seen = new Set<string>();
  const classifications = new Set([
    'load-bearing',
    'test-or-mirror',
    'generated',
    'incidental-reference',
    'irrelevant',
  ]);
  for (const [index, item] of value.dispositions.entries()) {
    const problem = dispositionProblem(item, index, classifications, seen);
    if (problem !== null) throw checkpointInvalid(problem);
    if (
      !isRecord(item) ||
      !hasExactKeys(item, [...DISPOSITION_KEYS]) ||
      typeof item.groupId !== 'string' ||
      !DIGEST.test(item.groupId) ||
      typeof item.classification !== 'string' ||
      !classifications.has(item.classification) ||
      typeof item.rationale !== 'string' ||
      item.rationale.trim().length === 0 ||
      typeof item.author !== 'string' ||
      item.author.trim().length === 0 ||
      seen.has(item.groupId)
    ) {
      throw checkpointInvalid();
    }
    seen.add(item.groupId);
  }
}

function assertWhyAnswersPayload(
  value: unknown,
): asserts value is WhyAnswersPayload {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['answers']) ||
    !Array.isArray(value.answers) ||
    value.answers.length > INVESTIGATION_LIMITS.maxHitDispositionWorkItems
  ) {
    throw checkpointInvalid(
      'payload must be { answers: [...] } with one row per manifest entry',
    );
  }
  const seen = new Set<string>();
  for (const [index, answer] of value.answers.entries()) {
    const problem = whyAnswerProblem(answer, index, seen);
    if (problem !== null) throw checkpointInvalid(problem);
    if (
      !isRecord(answer) ||
      !hasExactKeys(answer, [...WHY_ANSWER_KEYS]) ||
      typeof answer.manifestEntryId !== 'string' ||
      !DIGEST.test(answer.manifestEntryId) ||
      !isSemanticText(answer.why) ||
      !isSemanticText(answer.protectedInvariant) ||
      !isSemanticText(answer.reviewerQuestion) ||
      !isSemanticText(answer.answer) ||
      typeof answer.semanticAuthor !== 'string' ||
      answer.semanticAuthor.trim().length === 0 ||
      answer.readComplete !== true ||
      seen.has(answer.manifestEntryId)
    ) {
      throw checkpointInvalid();
    }
    seen.add(answer.manifestEntryId);
  }
}

function whyAnswerProblem(
  answer: unknown,
  index: number,
  seen: ReadonlySet<string>,
): string | null {
  const row = `answers[${index}]`;
  if (!isRecord(answer)) return `${row} must be an object`;
  const keysProblem = exactKeysProblem(answer, WHY_ANSWER_KEYS);
  if (keysProblem !== null) return `${row} ${keysProblem}`;
  if (
    typeof answer.manifestEntryId !== 'string' ||
    !DIGEST.test(answer.manifestEntryId)
  ) {
    return `${row}.manifestEntryId must be a manifestEntryId from work.fullBlobManifest`;
  }
  if (seen.has(answer.manifestEntryId)) {
    return `${row}.manifestEntryId repeats an earlier row`;
  }
  for (const field of [
    'why',
    'protectedInvariant',
    'reviewerQuestion',
    'answer',
  ] as const) {
    if (!isSemanticText(answer[field])) {
      return `${row}.${field} ${SEMANTIC_TEXT_RULE}`;
    }
  }
  if (
    typeof answer.semanticAuthor !== 'string' ||
    answer.semanticAuthor.trim().length === 0
  ) {
    return `${row}.semanticAuthor must name who authored the answer`;
  }
  if (answer.readComplete !== true) {
    return `${row}.readComplete must be true, set only after reading the whole blob`;
  }
  return null;
}

function isSemanticText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/\b(?:TODO|FIXME|TBD|XXX|WIP)\b/i.test(value) &&
    !/\{\{[\s\S]*?\}\}/.test(value) &&
    !/<(?!!)[^>]*>/.test(value)
  );
}

function isCheckpointKind(
  value: unknown,
): value is InvestigationCheckpointKind {
  return (
    value === 'main-terms' ||
    value === 'group-dispositions' ||
    value === 'why-answers'
  );
}

function checkpointInvalid(reason?: string) {
  return workflowError(
    'INVESTIGATION_CHECKPOINT_INVALID',
    reason === undefined
      ? 'Investigation caller checkpoint is malformed, unbounded, or unbound.'
      : `Investigation caller checkpoint is malformed, unbounded, or unbound: ${reason}.`,
    ExitCode.usage,
  );
}

/** Name the exact key mismatch so a caller can repair the envelope blind. */
function exactKeysProblem(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  const missing = keys.filter((key) => !(key in value));
  const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length === 0 && unexpected.length === 0) return null;
  return [
    missing.length > 0 ? `missing keys [${missing.join(', ')}]` : null,
    unexpected.length > 0 ? `unexpected keys [${unexpected.join(', ')}]` : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

const CHECKPOINT_ENVELOPE_KEYS = [
  'schemaVersion',
  'kind',
  'checkpointId',
  'investigationId',
  'changeId',
  'expectedRevision',
  'baseline',
  'intentDigest',
  'blindManifestDigest',
  'payload',
] as const;

const WHY_ANSWER_KEYS = [
  'manifestEntryId',
  'why',
  'protectedInvariant',
  'reviewerQuestion',
  'answer',
  'semanticAuthor',
  'readComplete',
] as const;

const DISPOSITION_KEYS = [
  'groupId',
  'classification',
  'rationale',
  'author',
] as const;

const SEMANTIC_TEXT_RULE =
  'must be plain prose: non-empty, without <...> or {{...}} placeholders, markup, or TODO markers';

function scanSaturationAcceptanceInvalid() {
  return workflowError(
    'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_INVALID',
    'Investigation scan saturation acceptance is malformed or unbound.',
    ExitCode.usage,
  );
}
