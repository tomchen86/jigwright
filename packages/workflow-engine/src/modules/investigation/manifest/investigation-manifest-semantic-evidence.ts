/**
 * Normalizes manifest semantic decisions and verifies their source and Why
 * evidence.
 *
 * Invariants:
 * - Load-bearing sources must retain replayable blob content.
 */
import type {
  AppliedInvestigationDisposition,
  InvestigationDispositionDecision,
  InvestigationSemanticGroupDecision,
  InvestigationGroupRef,
} from '../domain/investigation-domain.ts';
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';
import type { InvestigationScanSaturationDecision } from './investigation-replay-input.ts';
import type { MaterializedEvidenceView } from './investigation-materializer.ts';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import type { FloorOverflowDecision } from '../domain/floor-overflow-pruning.ts';
import { SEMANTIC_ASSURANCE } from '../domain/investigation-schema.ts';
import type {
  PersistedDisposition,
  InvestigationV3RoleResult,
  InvestigationAssuranceFacts,
  InvestigationWhyOverlayV3,
  InvestigationKnowledgeReuseDecision,
  InvestigationSemanticException,
  InvestigationSourceAnchor,
} from './investigation-manifest-types.ts';
import {
  unrepresentable,
  assertRecord,
  assertExactKeys,
  assertDigest,
  boundedText,
  normalizeDigestArray,
  normalizeSemanticAuthor,
  nullableText,
  normalizeTextArray,
  assertGitObjectId,
  assertUnique,
  ManifestValidationError,
  sourceTupleKey,
} from './investigation-manifest-values.ts';

const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function persistedDispositionsFrom(
  dispositions: AppliedInvestigationDisposition[],
): PersistedDisposition[] {
  return dispositions.map(
    ({ coveredHitKeys: _coveredHitKeys, ...disposition }) => disposition,
  );
}

export function persistedToDispositionDecisions(
  value: unknown,
): InvestigationDispositionDecision[] {
  if (!Array.isArray(value)) {
    throw unrepresentable('Persisted dispositions are malformed.');
  }
  return value.map((entry) => {
    const record = assertRecord(entry);
    assertExactKeys(record, [
      'groupRef',
      'classification',
      'rationale',
      'semanticAuthor',
      'dispositionDigest',
    ]);
    const groupRef = normalizeGroupRef(record.groupRef);
    assertDigest(record.dispositionDigest);
    return {
      groupKey: groupRef.key,
      classification: record.classification as string,
      rationale: record.rationale as string,
      semanticAuthor: record.semanticAuthor as InvestigationSemanticAuthor,
    };
  });
}

export function normalizeSemanticGroupDecisions(
  values: InvestigationSemanticGroupDecision[],
): InvestigationSemanticGroupDecision[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Semantic Group decisions are malformed.');
  }
  return values
    .map((value) => {
      const record = assertRecord(value);
      assertExactKeys(record, [
        'decisionId',
        'key',
        'title',
        'sourceMechanicalGroupKeys',
        'hitKeys',
        'rationale',
        'semanticAuthor',
      ]);
      return {
        decisionId: boundedText(record.decisionId, 'semantic decision ID'),
        key: boundedText(record.key, 'semantic Group key'),
        title: boundedText(record.title, 'semantic Group title'),
        sourceMechanicalGroupKeys: normalizeDigestArray(
          record.sourceMechanicalGroupKeys,
          false,
        ),
        hitKeys: normalizeDigestArray(record.hitKeys, false),
        rationale: boundedText(record.rationale, 'semantic Group rationale'),
        semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      };
    })
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

export function normalizeDispositionDecisions(
  values: InvestigationDispositionDecision[],
): InvestigationDispositionDecision[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Disposition decisions are malformed.');
  }
  return values
    .map((value) => {
      const record = assertRecord(value);
      assertExactKeys(record, [
        'groupKey',
        'classification',
        'rationale',
        'semanticAuthor',
      ]);
      return {
        groupKey: boundedText(record.groupKey, 'Disposition Group key'),
        classification: boundedText(
          record.classification,
          'Disposition classification',
        ),
        rationale: boundedText(record.rationale, 'Disposition rationale'),
        semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      };
    })
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

export function normalizeSaturationDecision(
  value: InvestigationScanSaturationDecision | null,
): InvestigationScanSaturationDecision | null {
  if (value === null) return null;
  const record = assertRecord(value);
  assertExactKeys(record, [
    'saturatedTermIds',
    'acknowledgeIncompleteScan',
    'rationale',
    'semanticAuthor',
    'provenanceDigest',
  ]);
  if (record.acknowledgeIncompleteScan !== true) {
    throw unrepresentable('Scan saturation acknowledgement is malformed.');
  }
  assertDigest(record.provenanceDigest);
  return {
    saturatedTermIds: normalizeDigestArray(record.saturatedTermIds, false),
    acknowledgeIncompleteScan: true,
    rationale: boundedText(record.rationale, 'saturation rationale'),
    semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
    provenanceDigest: record.provenanceDigest,
  };
}

export function normalizeRoleResults(
  values: InvestigationV3RoleResult[],
): InvestigationV3RoleResult[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Investigation role results are malformed.');
  }
  const results = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'role',
      'targetDigest',
      'providerId',
      'sessionId',
      'principalId',
      'requiredIndependence',
      'achievedIndependence',
      'requestDigest',
      'outputDigest',
      'contentDigest',
      'policyDigest',
      'provenanceDigest',
      'grantUse',
      'roleContextSharingUse',
    ]);
    if (
      record.role !== 'reviewer-pre-anchor' &&
      record.role !== 'investigation-reviewer'
    ) {
      throw unrepresentable('Investigation role is not investigation-owned.');
    }
    for (const key of [
      'targetDigest',
      'requestDigest',
      'outputDigest',
      'contentDigest',
      'policyDigest',
      'provenanceDigest',
    ]) {
      assertDigest(record[key]);
    }
    const grantUse = normalizeInvestigationGrantUse(record.grantUse);
    const roleContextSharingUse = normalizeInvestigationRoleContextSharingUse(
      record.roleContextSharingUse,
    );
    if (grantUse !== null && roleContextSharingUse !== null) {
      throw unrepresentable(
        'One investigation role result cannot claim two grant uses.',
      );
    }
    return {
      role: record.role,
      targetDigest: record.targetDigest as string,
      providerId: nullableText(record.providerId, 'provider ID'),
      sessionId: nullableText(record.sessionId, 'provider session ID'),
      principalId: nullableText(record.principalId, 'provider principal ID'),
      requiredIndependence: boundedText(
        record.requiredIndependence,
        'required independence',
      ),
      achievedIndependence: boundedText(
        record.achievedIndependence,
        'achieved independence',
      ),
      requestDigest: record.requestDigest as string,
      outputDigest: record.outputDigest as string,
      contentDigest: record.contentDigest as string,
      policyDigest: record.policyDigest as string,
      provenanceDigest: record.provenanceDigest as string,
      grantUse,
      roleContextSharingUse,
    } satisfies InvestigationV3RoleResult;
  });
  const sorted = results.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
  if (
    new Set(sorted.map((result) => canonicalJson(result))).size !==
    sorted.length
  ) {
    throw unrepresentable('Investigation role results contain duplicates.');
  }
  return sorted;
}

function normalizeInvestigationGrantUse(
  value: unknown,
): InvestigationV3RoleResult['grantUse'] {
  if (value === null) return null;
  const record = assertRecord(value);
  assertExactKeys(record, [
    'kind',
    'grantId',
    'signedEnvelopeDigest',
    'transitionDigest',
  ]);
  if (
    record.kind !== 'collaboration-grant-use-identity.v1' ||
    typeof record.grantId !== 'string' ||
    !GRANT_ID.test(record.grantId)
  ) {
    throw unrepresentable(
      'Investigation collaboration grant use is malformed.',
    );
  }
  assertDigest(record.signedEnvelopeDigest);
  assertDigest(record.transitionDigest);
  return {
    kind: 'collaboration-grant-use-identity.v1',
    grantId: record.grantId,
    signedEnvelopeDigest: record.signedEnvelopeDigest as string,
    transitionDigest: record.transitionDigest as string,
  };
}

function normalizeInvestigationRoleContextSharingUse(
  value: unknown,
): InvestigationV3RoleResult['roleContextSharingUse'] {
  if (value === null) return null;
  const record = assertRecord(value);
  assertExactKeys(record, [
    'kind',
    'grantId',
    'signedEnvelopeDigest',
    'transitionDigest',
    'useProjectionDigest',
    'admissionDigest',
  ]);
  if (
    record.kind !== 'role-context-sharing-use-identity.v1' ||
    typeof record.grantId !== 'string' ||
    !GRANT_ID.test(record.grantId)
  ) {
    throw unrepresentable(
      'Investigation role-context-sharing grant use is malformed.',
    );
  }
  for (const key of [
    'signedEnvelopeDigest',
    'transitionDigest',
    'useProjectionDigest',
    'admissionDigest',
  ]) {
    assertDigest(record[key]);
  }
  return {
    kind: 'role-context-sharing-use-identity.v1',
    grantId: record.grantId,
    signedEnvelopeDigest: record.signedEnvelopeDigest as string,
    transitionDigest: record.transitionDigest as string,
    useProjectionDigest: record.useProjectionDigest as string,
    admissionDigest: record.admissionDigest as string,
  };
}

export function normalizeAssuranceFacts(
  value: InvestigationAssuranceFacts,
): InvestigationAssuranceFacts {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'assessmentDigest',
    'coverageTier',
    'escalated',
    'reasons',
    'provenanceDigest',
  ]);
  assertDigest(record.assessmentDigest);
  assertDigest(record.provenanceDigest);
  if (
    record.coverageTier !== 'standard' &&
    record.coverageTier !== 'elevated' &&
    record.coverageTier !== 'critical'
  ) {
    throw unrepresentable('Assurance coverage tier is malformed.');
  }
  if (typeof record.escalated !== 'boolean') {
    throw unrepresentable('Assurance escalation is malformed.');
  }
  return {
    assessmentDigest: record.assessmentDigest as string,
    coverageTier: record.coverageTier,
    escalated: record.escalated,
    reasons: normalizeTextArray(record.reasons),
    provenanceDigest: record.provenanceDigest as string,
  };
}

export function normalizeFloorOverflowDecision(
  value: FloorOverflowDecision | null,
): FloorOverflowDecision | null {
  if (value === null) return null;
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'limit',
    'retainedLimit',
    'reservedNonFloorTerms',
    'observed',
    'escalated',
    'reasons',
    'dropped',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'floor-overflow-decision' ||
    !Number.isSafeInteger(record.limit) ||
    !Number.isSafeInteger(record.retainedLimit) ||
    !Number.isSafeInteger(record.reservedNonFloorTerms) ||
    !Number.isSafeInteger(record.observed) ||
    record.escalated !== true ||
    !Array.isArray(record.dropped)
  ) {
    throw unrepresentable('Floor-overflow decision is malformed.');
  }
  for (const dropped of record.dropped) {
    const entry = assertRecord(dropped);
    assertExactKeys(entry, ['termId', 'kind', 'value', 'reason']);
    assertDigest(entry.termId);
    boundedText(entry.kind, 'floor term kind');
    boundedText(entry.value, 'floor term value');
    boundedText(entry.reason, 'floor drop reason');
  }
  normalizeTextArray(record.reasons);
  return structuredClone(value);
}

export function normalizeWhyOverlays(
  values: InvestigationWhyOverlayV3[],
): InvestigationWhyOverlayV3[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('WHY overlays are malformed.');
  }
  const overlays = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'overlayId',
      'pathIdentity',
      'blobOid',
      'contentSha256',
      'groupRefs',
      'anchors',
      'why',
      'protectedInvariant',
      'reviewerQuestion',
      'answer',
      'semanticAuthor',
      'readComplete',
      'semanticAssurance',
    ]);
    if (
      record.readComplete !== true ||
      record.semanticAssurance !== SEMANTIC_ASSURANCE ||
      !Array.isArray(record.groupRefs) ||
      !Array.isArray(record.anchors) ||
      record.anchors.length === 0
    ) {
      throw unrepresentable('WHY overlay attestation is malformed.');
    }
    assertGitObjectId(record.blobOid);
    assertDigest(record.contentSha256);
    return {
      overlayId: boundedText(record.overlayId, 'WHY overlay ID'),
      pathIdentity: normalizePathIdentity(record.pathIdentity),
      blobOid: record.blobOid as string,
      contentSha256: record.contentSha256 as string,
      groupRefs: record.groupRefs
        .map(normalizeGroupRef)
        .sort((left, right) => left.index - right.index),
      anchors: record.anchors
        .map(normalizeSourceAnchor)
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      why: boundedText(record.why, 'WHY explanation'),
      protectedInvariant: boundedText(
        record.protectedInvariant,
        'protected invariant',
      ),
      reviewerQuestion: boundedText(
        record.reviewerQuestion,
        'reviewer question',
      ),
      answer: boundedText(record.answer, 'reviewer answer'),
      semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      readComplete: true as const,
      semanticAssurance: SEMANTIC_ASSURANCE,
    };
  });
  const sorted = overlays.sort((left, right) =>
    left.overlayId.localeCompare(right.overlayId),
  );
  assertUnique(
    sorted.map(({ overlayId }) => overlayId),
    'WHY overlay IDs',
  );
  return sorted;
}

export function normalizeKnowledgeReuseDecisions(
  values: InvestigationKnowledgeReuseDecision[],
): InvestigationKnowledgeReuseDecision[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Knowledge-reuse decisions are malformed.');
  }
  const decisions = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'decisionId',
      'pathIdentity',
      'blobOid',
      'knowledgeRef',
      'freshness',
    ]);
    const knowledgeRef = assertRecord(record.knowledgeRef);
    assertExactKeys(knowledgeRef, ['subjectId', 'versionDigest']);
    assertDigest(knowledgeRef.versionDigest);
    const freshness = assertRecord(record.freshness);
    assertExactKeys(freshness, [
      'decision',
      'rationale',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    if (freshness.decision !== 'fresh') {
      throw unrepresentable('Knowledge reuse is not explicitly fresh.');
    }
    assertGitObjectId(record.blobOid);
    assertDigest(freshness.provenanceDigest);
    return {
      decisionId: boundedText(record.decisionId, 'knowledge decision ID'),
      pathIdentity: normalizePathIdentity(record.pathIdentity),
      blobOid: record.blobOid as string,
      knowledgeRef: {
        subjectId: boundedText(knowledgeRef.subjectId, 'knowledge subject ID'),
        versionDigest: knowledgeRef.versionDigest as string,
      },
      freshness: {
        decision: 'fresh' as const,
        rationale: boundedText(
          freshness.rationale,
          'knowledge freshness rationale',
        ),
        semanticAuthor: normalizeSemanticAuthor(freshness.semanticAuthor),
        provenanceDigest: freshness.provenanceDigest as string,
      },
    };
  });
  const sorted = decisions.sort((left, right) =>
    left.decisionId.localeCompare(right.decisionId),
  );
  assertUnique(
    sorted.map(({ decisionId }) => decisionId),
    'knowledge decision IDs',
  );
  return sorted;
}

export function normalizeExceptions(
  values: InvestigationSemanticException[],
): InvestigationSemanticException[] {
  if (!Array.isArray(values)) {
    throw unrepresentable('Investigation exceptions are malformed.');
  }
  const exceptions = values.map((value) => {
    const record = assertRecord(value);
    assertExactKeys(record, [
      'exceptionId',
      'kind',
      'subjectKey',
      'rationale',
      'semanticAuthor',
      'provenanceDigest',
    ]);
    if (
      record.kind !== 'semantic-group' &&
      record.kind !== 'disposition' &&
      record.kind !== 'why' &&
      record.kind !== 'knowledge-reuse'
    ) {
      throw unrepresentable('Investigation exception kind is malformed.');
    }
    const kind = record.kind as InvestigationSemanticException['kind'];
    assertDigest(record.provenanceDigest);
    return {
      exceptionId: boundedText(record.exceptionId, 'exception ID'),
      kind,
      subjectKey: boundedText(record.subjectKey, 'exception subject'),
      rationale: boundedText(record.rationale, 'exception rationale'),
      semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
      provenanceDigest: record.provenanceDigest as string,
    };
  });
  const sorted = exceptions.sort((left, right) =>
    left.exceptionId.localeCompare(right.exceptionId),
  );
  assertUnique(
    sorted.map(({ exceptionId }) => exceptionId),
    'exception IDs',
  );
  return sorted;
}

export function validateWhyCoverage(
  view: MaterializedEvidenceView,
  overlays: InvestigationWhyOverlayV3[],
  knowledgeReuse: InvestigationKnowledgeReuseDecision[],
): void {
  const hitsByKey = new Map(view.grouping.hits.map((hit) => [hit.hitKey, hit]));
  const required = new Map<
    string,
    {
      pathIdentity: { rawBase64: string; utf8: string | null };
      blobOid: string;
      contentSha256: string;
      hitKeys: Set<string>;
      groupRefs: Map<string, InvestigationGroupRef>;
    }
  >();
  for (const disposition of view.dispositions) {
    if (disposition.classification !== 'load-bearing') continue;
    for (const hitKey of disposition.coveredHitKeys) {
      const hit = hitsByKey.get(hitKey)!;
      if (hit.sourceObject.contentSha256 === null) {
        throw new ManifestValidationError(
          'SOURCE_ANCHOR_UNRESOLVED',
          'Load-bearing source has no replayable blob content.',
        );
      }
      const key = sourceTupleKey(hit.path.rawBase64, hit.sourceObject.objectId);
      let row = required.get(key);
      if (row === undefined) {
        row = {
          pathIdentity: hit.path,
          blobOid: hit.sourceObject.objectId,
          contentSha256: hit.sourceObject.contentSha256,
          hitKeys: new Set(),
          groupRefs: new Map(),
        };
        required.set(key, row);
      }
      row.hitKeys.add(hitKey);
      row.groupRefs.set(disposition.groupRef.key, disposition.groupRef);
    }
  }

  const covered = new Set<string>();
  for (const overlay of overlays) {
    const key = sourceTupleKey(overlay.pathIdentity.rawBase64, overlay.blobOid);
    const row = required.get(key);
    if (
      row === undefined ||
      covered.has(key) ||
      canonicalJson(row.pathIdentity) !== canonicalJson(overlay.pathIdentity) ||
      row.contentSha256 !== overlay.contentSha256
    ) {
      throw new ManifestValidationError(
        'SOURCE_ANCHOR_UNRESOLVED',
        'WHY overlay does not map one-to-one to current load-bearing source.',
      );
    }
    const expectedRefs = [...row.groupRefs.values()].sort(
      (left, right) => left.index - right.index,
    );
    if (canonicalJson(expectedRefs) !== canonicalJson(overlay.groupRefs)) {
      throw new ManifestValidationError(
        'SOURCE_ANCHOR_UNRESOLVED',
        'WHY overlay Group references are stale.',
      );
    }
    const hitKeysCovered = new Set<string>();
    for (const anchor of overlay.anchors) {
      if (
        anchor.pathIdentity.rawBase64 !== row.pathIdentity.rawBase64 ||
        anchor.blobOid !== row.blobOid
      ) {
        throw new ManifestValidationError(
          'SOURCE_ANCHOR_UNRESOLVED',
          'WHY source anchor targets a different Git object.',
        );
      }
      const match = view.grouping.hits.find(
        (hit) =>
          row.hitKeys.has(hit.hitKey) &&
          hit.termId === anchor.termId &&
          hit.byteOffset === anchor.byteRange.start &&
          hit.byteOffset + hit.byteLength === anchor.byteRange.end,
      );
      if (match === undefined) {
        throw new ManifestValidationError(
          'SOURCE_ANCHOR_UNRESOLVED',
          'WHY source anchor does not resolve to a current hit.',
        );
      }
      hitKeysCovered.add(match.hitKey);
    }
    if (hitKeysCovered.size !== row.hitKeys.size) {
      throw new ManifestValidationError(
        'SOURCE_ANCHOR_UNRESOLVED',
        'WHY overlay does not anchor every current load-bearing hit.',
      );
    }
    covered.add(key);
  }
  for (const decision of knowledgeReuse) {
    const key = sourceTupleKey(
      decision.pathIdentity.rawBase64,
      decision.blobOid,
    );
    const row = required.get(key);
    if (
      row === undefined ||
      covered.has(key) ||
      canonicalJson(row.pathIdentity) !== canonicalJson(decision.pathIdentity)
    ) {
      throw new ManifestValidationError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Knowledge reuse does not map one-to-one to current load-bearing source.',
      );
    }
    covered.add(key);
  }
  if (covered.size !== required.size) {
    throw new ManifestValidationError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Every load-bearing Git path/blob requires one WHY overlay or fresh knowledge reuse.',
    );
  }
}

function normalizeSourceAnchor(value: unknown): InvestigationSourceAnchor {
  const record = assertRecord(value);
  assertExactKeys(record, ['pathIdentity', 'blobOid', 'byteRange', 'termId']);
  assertGitObjectId(record.blobOid);
  assertDigest(record.termId);
  const byteRange = assertRecord(record.byteRange);
  assertExactKeys(byteRange, ['start', 'end']);
  if (
    !Number.isSafeInteger(byteRange.start) ||
    !Number.isSafeInteger(byteRange.end) ||
    (byteRange.start as number) < 0 ||
    (byteRange.end as number) <= (byteRange.start as number)
  ) {
    throw unrepresentable('Source anchor byte range is malformed.');
  }
  return {
    pathIdentity: normalizePathIdentity(record.pathIdentity),
    blobOid: record.blobOid as string,
    byteRange: {
      start: byteRange.start as number,
      end: byteRange.end as number,
    },
    termId: record.termId as string,
  };
}

function normalizeGroupRef(value: unknown): InvestigationGroupRef {
  const record = assertRecord(value);
  assertExactKeys(record, ['index', 'key', 'leafDigest']);
  if (!Number.isSafeInteger(record.index) || (record.index as number) < 0) {
    throw unrepresentable('Compact Group reference index is malformed.');
  }
  assertDigest(record.leafDigest);
  return {
    index: record.index as number,
    key: boundedText(record.key, 'compact Group key'),
    leafDigest: record.leafDigest as string,
  };
}

function normalizePathIdentity(value: unknown): {
  rawBase64: string;
  utf8: string | null;
} {
  const record = assertRecord(value);
  assertExactKeys(record, ['rawBase64', 'utf8']);
  if (
    typeof record.rawBase64 !== 'string' ||
    (record.utf8 !== null && typeof record.utf8 !== 'string')
  ) {
    throw unrepresentable('Raw Git path identity is malformed.');
  }
  const raw = Buffer.from(record.rawBase64, 'base64');
  if (
    raw.length === 0 ||
    raw.toString('base64') !== record.rawBase64 ||
    raw.includes(0) ||
    raw[0] === 0x2f ||
    raw.at(-1) === 0x2f
  ) {
    throw unrepresentable('Raw Git path identity is malformed.');
  }
  if (record.utf8 !== null) {
    const utf8 = raw.toString('utf8');
    if (
      utf8 !== record.utf8 ||
      Buffer.compare(Buffer.from(utf8, 'utf8'), raw) !== 0
    ) {
      throw unrepresentable('Display path does not match raw Git bytes.');
    }
  }
  return { rawBase64: record.rawBase64, utf8: record.utf8 };
}
