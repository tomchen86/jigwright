import {
  INVESTIGATION_MANIFEST_V3_KIND,
  INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
} from '../domain/investigation-schema.ts';
import type {
  ExemptionInvestigationApplicabilityV3,
  ExemptionInvestigationAuthoringState,
  InvestigationApprovalV3,
  InvestigationAssuranceFacts,
  InvestigationAuthoringState,
  InvestigationKnowledgeReuseDecision,
  InvestigationManifestDraftV3,
  InvestigationManifestV3,
  InvestigationSemanticException,
  InvestigationV3Blocker,
  InvestigationV3FailureCode,
  InvestigationV3RoleResult,
  InvestigationWhyOverlayV3,
  ManifestIdentity,
  OrdinaryInvestigationApplicabilityV3,
  OrdinaryInvestigationAuthoringState,
} from './investigation-manifest-types.ts';
/**
 * Builds, seals, and validates v3 Investigation Manifests and structured
 * blockers.
 *
 * Invariants:
 * - Authority validation requires manifest identity to match the lifecycle
 *   snapshot.
 */
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../../foundation/errors/errors.ts';
import type { NormalizedChangeIntent } from '../../source/change-intent.ts';
import type { MutationClassPolicy } from '../../source/mutation-class-policy.ts';
import type { FloorOverflowDecision } from '../domain/floor-overflow-pruning.ts';
import type {
  InvestigationChangeClass,
  InvestigationExemptionCategory,
  InvestigationSemanticAuthor,
} from '../domain/investigation-applicability.ts';
import { createInvestigationApplicability } from '../domain/investigation-applicability.ts';
import type { InvestigationSemanticGroupDecision } from '../domain/investigation-domain.ts';
import type {
  DeclaredInvestigationRoot,
  ReviewedPathRelationship,
} from '../domain/investigation-groups.ts';
import {
  INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
  INVESTIGATION_TERM_NORMALIZATION_VERSION,
  SEMANTIC_ASSURANCE,
} from '../domain/investigation-schema.ts';
import type {
  InvestigationLimits,
  InvestigationTermContribution,
  PreviewInvestigationTerm,
} from '../domain/investigation-terms.ts';
import { normalizeInvestigationTerm } from '../domain/investigation-terms.ts';
import type { InvestigationV3Baseline } from './investigation-baseline.ts';
import {
  assertOrdinaryPlanReviewCoverageBinding,
  normalizeRequirements,
} from './investigation-manifest-requirements.ts';
import {
  normalizeAssuranceFacts,
  normalizeDispositionDecisions,
  normalizeExceptions,
  normalizeFloorOverflowDecision,
  normalizeKnowledgeReuseDecisions,
  normalizeRoleResults,
  normalizeSaturationDecision,
  normalizeSemanticGroupDecisions,
  normalizeWhyOverlays,
  persistedDispositionsFrom,
  persistedToDispositionDecisions,
  validateWhyCoverage,
} from './investigation-manifest-semantic-evidence.ts';
import {
  assertDigest,
  assertExactKeys,
  assertGitObjectId,
  assertRecord,
  assertUnique,
  boundedText,
  deepFreeze,
  DIGEST,
  digest,
  digestWithDomain,
  isRecord,
  ManifestValidationError,
  normalizeSemanticAuthor,
  normalizeTextArray,
  unrepresentable,
} from './investigation-manifest-values.ts';
import type { InvestigationEvidenceReplayer } from './investigation-materializer.ts';
import type {
  InvestigationReplayAuthoringInput,
  InvestigationScanSaturationDecision,
} from './investigation-replay-input.ts';
import type { InvestigationRequirementV3 } from './investigation-requirement-types.ts';

const ASSURANCE_FACT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/**
 * Structured v3 failure emitter. This is deliberately only a failure contract:
 * it issues, stores, consumes, or binds no continuation grant.
 */
export function createInvestigationV3Blocker(input: {
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'];
  candidate: unknown;
  failureCode: InvestigationV3FailureCode;
  message: string;
  details?: Record<string, unknown>;
}): InvestigationV3Blocker {
  return blockedWithCode(
    input.attemptedTransition,
    input.candidate,
    input.failureCode,
    input.message,
    input.details,
  ).blocker;
}

/**
 * Converts an engine exception through the same normalization path used by the
 * built-in v3 transition emitters.
 */
export function createInvestigationV3BlockerFromError(input: {
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'];
  candidate: unknown;
  error: unknown;
}): InvestigationV3Blocker {
  return blocked(input.attemptedTransition, input.candidate, input.error)
    .blocker;
}

export function parseInvestigationV3Blocker(
  value: unknown,
): InvestigationV3Blocker {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'failureIdentity',
    'attemptedTransition',
    'candidateDigest',
    'failureCode',
    'detailsDigest',
    'missingAssuranceFacts',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-v3-failure' ||
    typeof record.failureIdentity !== 'string' ||
    !DIGEST.test(record.failureIdentity) ||
    !INVESTIGATION_V3_ATTEMPTED_TRANSITIONS.includes(
      record.attemptedTransition as InvestigationV3Blocker['attemptedTransition'],
    ) ||
    typeof record.candidateDigest !== 'string' ||
    !DIGEST.test(record.candidateDigest) ||
    !isSafeInvestigationV3FailureCode(record.failureCode) ||
    typeof record.detailsDigest !== 'string' ||
    !DIGEST.test(record.detailsDigest) ||
    !Array.isArray(record.missingAssuranceFacts) ||
    !record.missingAssuranceFacts.every(
      (fact) => typeof fact === 'string' && ASSURANCE_FACT_ID.test(fact),
    ) ||
    new Set(record.missingAssuranceFacts).size !==
      record.missingAssuranceFacts.length ||
    canonicalJson(record.missingAssuranceFacts) !==
      canonicalJson([...record.missingAssuranceFacts].sort())
  ) {
    throw unrepresentable('Investigation v3 blocker is malformed.');
  }
  const blocker = {
    schemaVersion: 1 as const,
    kind: 'investigation-v3-failure' as const,
    failureIdentity: record.failureIdentity,
    attemptedTransition:
      record.attemptedTransition as InvestigationV3Blocker['attemptedTransition'],
    candidateDigest: record.candidateDigest,
    failureCode: record.failureCode,
    detailsDigest: record.detailsDigest,
    missingAssuranceFacts: [...record.missingAssuranceFacts],
  };
  const expectedIdentity = digestWithDomain('investigation-v3-failure/v1', {
    attemptedTransition: blocker.attemptedTransition,
    candidateDigest: blocker.candidateDigest,
    failureCode: blocker.failureCode,
    detailsDigest: blocker.detailsDigest,
    missingAssuranceFacts: blocker.missingAssuranceFacts,
  });
  if (blocker.failureIdentity !== expectedIdentity) {
    throw unrepresentable(
      'Investigation v3 blocker identity does not match its facts.',
    );
  }
  return deepFreeze(blocker);
}

type BuiltResult =
  | { outcome: 'built'; draft: InvestigationManifestDraftV3 }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

type VerifiedDraftResult =
  | {
      outcome: 'verified';
      draft: InvestigationManifestDraftV3;
      applicabilityContentDigest: string;
      investigationTargetDigest: string;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

type SealedResult =
  | { outcome: 'sealed'; manifest: InvestigationManifestV3 }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

type AuthorityValidationResult =
  | {
      outcome: 'verified';
      manifest: InvestigationManifestV3;
      manifestDigest: string;
      investigationTargetDigest: string;
    }
  | { outcome: 'blocked'; blocker: InvestigationV3Blocker };

export function buildInvestigationManifestDraft(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  input: {
    repositoryRoot: string;
    state: InvestigationAuthoringState;
  },
): BuiltResult {
  try {
    const identity = normalizeAuthoringIdentity(input.state);
    const intentDigest = digest(identity.normalizedIntent);
    const applicability =
      input.state.applicabilityKind === 'ordinary'
        ? buildOrdinaryApplicability(
            materializeInvestigationEvidenceView,
            input.repositoryRoot,
            input.state,
            identity,
          )
        : buildExemptionApplicability(input.state, intentDigest);
    return {
      outcome: 'built',
      draft: deepFreeze({
        schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
        kind: INVESTIGATION_MANIFEST_V3_KIND,
        repositoryId: identity.repositoryId,
        changeId: identity.changeId,
        investigationId: identity.investigationId,
        normalizedIntent: identity.normalizedIntent,
        intentDigest,
        authoring: identity.authoring,
        applicability,
        investigationApproval: null,
        manifestDigest: null,
      }),
    };
  } catch (error) {
    return blocked('build-draft', input.state, error);
  }
}

export function validateDraftForSeal(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  input: {
    repositoryRoot: string;
    draft: unknown;
  },
): VerifiedDraftResult {
  try {
    const draft = parseDraft(
      materializeInvestigationEvidenceView,
      input.repositoryRoot,
      input.draft,
    );
    const applicabilityContentDigest = digestWithDomain(
      'investigation-applicability-content/v3',
      draft.applicability,
    );
    return {
      outcome: 'verified',
      draft,
      applicabilityContentDigest,
      investigationTargetDigest: investigationTargetDigest(
        draft,
        applicabilityContentDigest,
      ),
    };
  } catch (error) {
    return blocked('draft-seal', input.draft, error);
  }
}

export function sealInvestigationManifestDraft(input: {
  draft: InvestigationManifestDraftV3;
  approval: {
    semanticAuthor: InvestigationSemanticAuthor;
    approvalProvenanceDigest: string;
  };
}): SealedResult {
  try {
    assertDraftShape(input.draft);
    const semanticAuthor = normalizeSemanticAuthor(
      input.approval.semanticAuthor,
    );
    assertDigest(input.approval.approvalProvenanceDigest);
    const applicabilityContentDigest = digestWithDomain(
      'investigation-applicability-content/v3',
      input.draft.applicability,
    );
    const targetDigest = investigationTargetDigest(
      input.draft,
      applicabilityContentDigest,
    );
    const approvalWithoutSeal = {
      schemaVersion: 1 as const,
      kind: 'investigation-approval' as const,
      investigationTargetDigest: targetDigest,
      semanticAuthor,
      approvalProvenanceDigest: input.approval.approvalProvenanceDigest,
      semanticAssurance: SEMANTIC_ASSURANCE,
    };
    const investigationApproval = {
      ...approvalWithoutSeal,
      sealDigest: digestWithDomain(
        'investigation-approval-seal/v3',
        approvalWithoutSeal,
      ),
    };
    const withoutManifestDigest = {
      ...input.draft,
      investigationApproval,
      manifestDigest: undefined,
    };
    delete (withoutManifestDigest as { manifestDigest?: unknown })
      .manifestDigest;
    const manifestDigest = digestWithDomain(
      'investigation-manifest/v3',
      withoutManifestDigest,
    );
    return {
      outcome: 'sealed',
      manifest: deepFreeze({
        ...input.draft,
        investigationApproval,
        manifestDigest,
      }),
    };
  } catch (error) {
    return blocked('draft-seal', input.draft, error);
  }
}

export function validateForAuthority(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  input: {
    repositoryRoot: string;
    manifest: unknown;
    expected: {
      repositoryId: string;
      changeId: string;
      investigationId: string;
      sessionRevision: number;
      sessionSnapshotDigest: string;
    };
  },
): AuthorityValidationResult {
  if (isRecord(input.manifest) && input.manifest.schemaVersion === 1) {
    return blockedWithCode(
      'authority-validation',
      input.manifest,
      'SCHEMA_V1_FORBIDDEN',
      'Schema v1 cannot satisfy the v3 authority boundary.',
    );
  }
  try {
    const manifest = parseFinalManifest(
      materializeInvestigationEvidenceView,
      input.repositoryRoot,
      input.manifest,
    );
    if (
      manifest.repositoryId !== input.expected.repositoryId ||
      manifest.changeId !== input.expected.changeId ||
      manifest.investigationId !== input.expected.investigationId ||
      manifest.authoring.sessionRevision !== input.expected.sessionRevision ||
      manifest.authoring.sessionSnapshotDigest !==
        input.expected.sessionSnapshotDigest
    ) {
      throw new ManifestValidationError(
        'REVIEW_TARGET_STALE',
        'Manifest identity no longer matches the lifecycle authority snapshot.',
      );
    }
    return {
      outcome: 'verified',
      manifest,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
    };
  } catch (error) {
    return blocked('authority-validation', input.manifest, error);
  }
}

function buildOrdinaryApplicability(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  repositoryRoot: string,
  state: OrdinaryInvestigationAuthoringState,
  parentIdentity: ManifestIdentity,
): OrdinaryInvestigationApplicabilityV3 {
  const termContributions = [...state.ordinary.termContributions]
    .map((value) => structuredClone(value))
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
  const semanticGroupDecisions = normalizeSemanticGroupDecisions(
    state.ordinary.semanticGroupDecisions,
  );
  const dispositionDecisions = normalizeDispositionDecisions(
    state.ordinary.dispositionDecisions,
  );
  const replayAuthoring: InvestigationReplayAuthoringInput = {
    baseline: normalizeBaseline(state.ordinary.baseline),
    termContributions,
    canonicalTerms: structuredClone(state.ordinary.canonicalTerms),
    scanner: {
      ...(state.ordinary.scanner.limits === undefined
        ? {}
        : { limits: structuredClone(state.ordinary.scanner.limits) }),
      allowSaturatedTerms: state.ordinary.scanner.allowSaturatedTerms === true,
      saturationDecision: normalizeSaturationDecision(
        state.ordinary.scanner.saturationDecision,
      ),
    },
    grouping: {
      mutationPolicy: structuredClone(state.ordinary.grouping.mutationPolicy),
      declaredRoots: [...state.ordinary.grouping.declaredRoots]
        .map((value) => structuredClone(value))
        .sort((left, right) => left.rootId.localeCompare(right.rootId)),
      reviewedRelationships: [...state.ordinary.grouping.reviewedRelationships]
        .map((value) => structuredClone(value))
        .sort((left, right) =>
          left.relationshipId.localeCompare(right.relationshipId),
        ),
    },
    semanticGroupDecisions,
    dispositionDecisions,
  };
  assertIntentFloor(state.normalizedIntent, replayAuthoring.canonicalTerms);
  const view = materializeInvestigationEvidenceView({
    repositoryRoot,
    authoring: replayAuthoring,
  });
  const investigationRoleResults = normalizeRoleResults(
    state.ordinary.investigationRoleResults,
  );
  if (
    !investigationRoleResults.some(({ role }) => role === 'reviewer-pre-anchor')
  ) {
    throw new ManifestValidationError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Ordinary investigation requires an admitted Reviewer pre-anchor result.',
    );
  }
  const whyOverlays = normalizeWhyOverlays(state.ordinary.whyOverlays);
  const knowledgeReuseDecisions = normalizeKnowledgeReuseDecisions(
    state.ordinary.knowledgeReuseDecisions,
  );
  validateWhyCoverage(view, whyOverlays, knowledgeReuseDecisions);
  const exceptions = normalizeExceptions(state.ordinary.exceptions);
  const investigationRequirements = normalizeRequirements(
    state.ordinary.investigationRequirements,
  );
  assertOrdinaryPlanReviewCoverageBinding({
    requirements: investigationRequirements,
    expected: {
      changeId: parentIdentity.changeId,
      investigationId: parentIdentity.investigationId,
      baseline: replayAuthoring.baseline,
    },
  });
  const assuranceFacts = normalizeAssuranceFacts(state.ordinary.assuranceFacts);
  const floorOverflowDecision = normalizeFloorOverflowDecision(
    state.ordinary.floorOverflowDecision,
  );
  const persistedDispositions = persistedDispositionsFrom(view.dispositions);

  return deepFreeze({
    kind: 'ordinary',
    replayContract: {
      baseline: replayAuthoring.baseline,
      termContributions,
      canonicalTerms: view.canonicalTerms,
      termNormalizationVersion: INVESTIGATION_TERM_NORMALIZATION_VERSION,
      termSetDigest: view.termSetDigest,
      scanner: {
        evaluatorId: 'investigation-scanner.v1',
        policyDigest: view.scanFacts.policyDigest,
        canonicalizationVersion: 'investigation-scan-canonicalization.v1',
        limits: view.limits,
        allowSaturatedTerms: replayAuthoring.scanner.allowSaturatedTerms,
      },
      grouping: {
        evaluatorId: 'investigation-groups.v1',
        policyDigest: view.grouping.groupingPolicyDigest,
        canonicalizationVersion: 'investigation-mechanical-groups.v3',
        mutationPolicy: replayAuthoring.grouping.mutationPolicy,
        declaredRoots: replayAuthoring.grouping.declaredRoots,
        reviewedRelationships: replayAuthoring.grouping.reviewedRelationships,
      },
      coverage: {
        evaluatorId: 'investigation-coverage.v3',
        canonicalizationVersion: INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
      },
      inventoryRoot: view.commitments.inventoryRoot,
      hitRoot: view.commitments.hitRoot,
      mechanicalGroupRoot: view.commitments.mechanicalGroupRoot,
      counts: {
        terms: view.canonicalTerms.length,
        hits: view.commitments.hitCount,
        mechanicalGroups: view.commitments.mechanicalGroupCount,
      },
    },
    semanticDelta: {
      investigationRoleResults,
      scanSaturationDecision: replayAuthoring.scanner.saturationDecision,
      floorOverflowDecision,
      semanticGroupDecisions,
      finalGroupRoot: view.commitments.finalGroupRoot,
      dispositions: persistedDispositions,
      whyOverlays,
      knowledgeReuseDecisions,
      exceptions,
      investigationRequirements,
      assuranceFacts,
    },
    derivedCommitments: {
      coverageRoot: view.commitments.coverageRoot,
      zeroHitTermIds: view.commitments.zeroHitTermIds,
      finalGroupCount: view.commitments.finalGroupCount,
    },
  });
}

function buildExemptionApplicability(
  state: ExemptionInvestigationAuthoringState,
  intentDigest: string,
): ExemptionInvestigationApplicabilityV3 {
  const baseline = normalizeBaseline(state.exemption.baseline);
  const applicability = createInvestigationApplicability({
    kind: 'investigation-exemption',
    category: state.exemption.category,
    baseline: { head: baseline.commitOid, tree: baseline.treeOid },
    intentDigest,
    declaredPaths: structuredClone(state.exemption.declaredPaths),
    declaredChangeClasses: structuredClone(
      state.exemption.declaredChangeClasses,
    ),
    rationale: state.exemption.rationale,
    semanticAuthor: structuredClone(state.exemption.semanticAuthor),
    nonTrivialBehaviorReliance: state.exemption.nonTrivialBehaviorReliance,
    researchBudgetMinutes: state.exemption.researchBudgetMinutes,
  });
  if (applicability.kind !== 'investigation-exemption') {
    throw new ManifestValidationError(
      'MANIFEST_UNREPRESENTABLE',
      'Exemption applicability normalization selected the wrong branch.',
    );
  }
  return deepFreeze({
    kind: 'exemption',
    category: applicability.category,
    baseline,
    declaredPaths: [...applicability.declaredPaths],
    declaredChangeClasses: [...applicability.declaredChangeClasses],
    rationale: applicability.rationale,
    semanticAuthor: applicability.semanticAuthor,
    nonTrivialBehaviorReliance: applicability.nonTrivialBehaviorReliance,
    researchBudgetMinutes: applicability.researchBudgetMinutes,
    policyDigest: applicability.policyDigest,
    applicabilityDigest: applicability.applicabilityDigest,
  });
}

function parseDraft(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  repositoryRoot: string,
  value: unknown,
): InvestigationManifestDraftV3 {
  const record = assertManifestTop(value);
  if (record.investigationApproval !== null || record.manifestDigest !== null) {
    throw unrepresentable('Draft contains final approval state.');
  }
  const identity = parseManifestIdentity(record);
  const applicability = parseApplicability(
    materializeInvestigationEvidenceView,
    repositoryRoot,
    identity,
    record.applicability,
  );
  return deepFreeze({
    ...identity,
    applicability,
    investigationApproval: null,
    manifestDigest: null,
  });
}

function parseFinalManifest(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  repositoryRoot: string,
  value: unknown,
): InvestigationManifestV3 {
  const record = assertManifestTop(value);
  const identity = parseManifestIdentity(record);
  const applicability = parseApplicability(
    materializeInvestigationEvidenceView,
    repositoryRoot,
    identity,
    record.applicability,
  );
  const draft: InvestigationManifestDraftV3 = {
    ...identity,
    applicability,
    investigationApproval: null,
    manifestDigest: null,
  };
  const approval = parseApproval(record.investigationApproval);
  const applicabilityContentDigest = digestWithDomain(
    'investigation-applicability-content/v3',
    applicability,
  );
  const targetDigest = investigationTargetDigest(
    draft,
    applicabilityContentDigest,
  );
  if (approval.investigationTargetDigest !== targetDigest) {
    throw new ManifestValidationError(
      'REVIEW_TARGET_STALE',
      'Investigation approval targets different Manifest content.',
    );
  }
  const approvalWithoutSeal = { ...approval };
  delete (approvalWithoutSeal as { sealDigest?: unknown }).sealDigest;
  if (
    approval.sealDigest !==
    digestWithDomain('investigation-approval-seal/v3', approvalWithoutSeal)
  ) {
    throw new ManifestValidationError(
      'RECONSTRUCTION_MISMATCH',
      'Investigation approval seal does not match recomputation.',
    );
  }
  if (typeof record.manifestDigest !== 'string') {
    throw unrepresentable('Final Manifest digest is absent.');
  }
  assertDigest(record.manifestDigest);
  const withoutManifestDigest = {
    ...identity,
    applicability,
    investigationApproval: approval,
  };
  const expectedManifestDigest = digestWithDomain(
    'investigation-manifest/v3',
    withoutManifestDigest,
  );
  if (record.manifestDigest !== expectedManifestDigest) {
    throw new ManifestValidationError(
      'RECONSTRUCTION_MISMATCH',
      'Manifest digest does not match the exact final Manifest.',
    );
  }
  return deepFreeze({
    ...withoutManifestDigest,
    manifestDigest: expectedManifestDigest,
  });
}

function parseApplicability(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  repositoryRoot: string,
  identity: ManifestIdentity,
  value: unknown,
):
  OrdinaryInvestigationApplicabilityV3 | ExemptionInvestigationApplicabilityV3 {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw unrepresentable('Manifest applicability branch is malformed.');
  }
  if (value.kind === 'exemption') {
    assertExactKeys(value, [
      'kind',
      'category',
      'baseline',
      'declaredPaths',
      'declaredChangeClasses',
      'rationale',
      'semanticAuthor',
      'nonTrivialBehaviorReliance',
      'researchBudgetMinutes',
      'policyDigest',
      'applicabilityDigest',
    ]);
    const state: ExemptionInvestigationAuthoringState = {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: identity.repositoryId,
      changeId: identity.changeId,
      investigationId: identity.investigationId,
      normalizedIntent: identity.normalizedIntent,
      authoring: identity.authoring,
      exemption: {
        category: value.category as InvestigationExemptionCategory,
        baseline: value.baseline as InvestigationV3Baseline,
        declaredPaths: value.declaredPaths as string[],
        declaredChangeClasses:
          value.declaredChangeClasses as InvestigationChangeClass[],
        rationale: value.rationale as string,
        semanticAuthor: value.semanticAuthor as InvestigationSemanticAuthor,
        nonTrivialBehaviorReliance:
          value.nonTrivialBehaviorReliance as 'none-declared',
        researchBudgetMinutes: value.researchBudgetMinutes as number | null,
      },
    };
    const rebuilt = buildExemptionApplicability(state, identity.intentDigest);
    if (canonicalJson(rebuilt) !== canonicalJson(value)) {
      throw new ManifestValidationError(
        'RECONSTRUCTION_MISMATCH',
        'Exemption applicability does not match recomputation.',
      );
    }
    return rebuilt;
  }
  if (value.kind !== 'ordinary') {
    throw unrepresentable('Unknown Manifest applicability branch.');
  }
  assertExactKeys(value, [
    'kind',
    'replayContract',
    'semanticDelta',
    'derivedCommitments',
  ]);
  const replay = assertOrdinaryReplayShape(value.replayContract);
  const semantic = assertSemanticDeltaShape(value.semanticDelta);
  assertDerivedCommitmentsShape(value.derivedCommitments);
  const state: OrdinaryInvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'ordinary',
    repositoryId: identity.repositoryId,
    changeId: identity.changeId,
    investigationId: identity.investigationId,
    normalizedIntent: identity.normalizedIntent,
    authoring: identity.authoring,
    ordinary: {
      baseline: replay.baseline as InvestigationV3Baseline,
      termContributions:
        replay.termContributions as InvestigationTermContribution[],
      canonicalTerms: replay.canonicalTerms as PreviewInvestigationTerm[],
      scanner: {
        limits: replay.scanner.limits as InvestigationLimits,
        allowSaturatedTerms: replay.scanner.allowSaturatedTerms as boolean,
        saturationDecision:
          semantic.scanSaturationDecision as InvestigationScanSaturationDecision | null,
      },
      grouping: {
        mutationPolicy: replay.grouping.mutationPolicy as MutationClassPolicy,
        declaredRoots: replay.grouping
          .declaredRoots as DeclaredInvestigationRoot[],
        reviewedRelationships: replay.grouping
          .reviewedRelationships as ReviewedPathRelationship[],
      },
      semanticGroupDecisions:
        semantic.semanticGroupDecisions as InvestigationSemanticGroupDecision[],
      dispositionDecisions: persistedToDispositionDecisions(
        semantic.dispositions,
      ),
      whyOverlays: semantic.whyOverlays as InvestigationWhyOverlayV3[],
      knowledgeReuseDecisions:
        semantic.knowledgeReuseDecisions as InvestigationKnowledgeReuseDecision[],
      investigationRoleResults:
        semantic.investigationRoleResults as InvestigationV3RoleResult[],
      floorOverflowDecision:
        semantic.floorOverflowDecision as FloorOverflowDecision | null,
      exceptions: semantic.exceptions as InvestigationSemanticException[],
      investigationRequirements:
        semantic.investigationRequirements as InvestigationRequirementV3[],
      assuranceFacts: semantic.assuranceFacts as InvestigationAssuranceFacts,
    },
  };
  const rebuilt = buildOrdinaryApplicability(
    materializeInvestigationEvidenceView,
    repositoryRoot,
    state,
    identity,
  );
  if (canonicalJson(rebuilt) !== canonicalJson(value)) {
    throw new ManifestValidationError(
      'RECONSTRUCTION_MISMATCH',
      'Ordinary Manifest does not match exact Git-backed replay.',
    );
  }
  return rebuilt;
}

type ParsedReplayShape = Record<string, unknown> & {
  baseline: unknown;
  termContributions: unknown;
  canonicalTerms: unknown;
  scanner: Record<string, unknown>;
  grouping: Record<string, unknown>;
};

type ParsedSemanticShape = Record<string, unknown> & {
  investigationRoleResults: unknown;
  scanSaturationDecision: unknown;
  floorOverflowDecision: unknown;
  semanticGroupDecisions: unknown;
  dispositions: unknown;
  whyOverlays: unknown;
  knowledgeReuseDecisions: unknown;
  exceptions: unknown;
  investigationRequirements: unknown;
  assuranceFacts: unknown;
};

function assertOrdinaryReplayShape(value: unknown): ParsedReplayShape {
  const replay = assertRecord(value);
  assertExactKeys(replay, [
    'baseline',
    'termContributions',
    'canonicalTerms',
    'termNormalizationVersion',
    'termSetDigest',
    'scanner',
    'grouping',
    'coverage',
    'inventoryRoot',
    'hitRoot',
    'mechanicalGroupRoot',
    'counts',
  ]);
  const scanner = assertRecord(replay.scanner);
  assertExactKeys(scanner, [
    'evaluatorId',
    'policyDigest',
    'canonicalizationVersion',
    'limits',
    'allowSaturatedTerms',
  ]);
  const grouping = assertRecord(replay.grouping);
  assertExactKeys(grouping, [
    'evaluatorId',
    'policyDigest',
    'canonicalizationVersion',
    'mutationPolicy',
    'declaredRoots',
    'reviewedRelationships',
  ]);
  const coverage = assertRecord(replay.coverage);
  assertExactKeys(coverage, ['evaluatorId', 'canonicalizationVersion']);
  const counts = assertRecord(replay.counts);
  assertExactKeys(counts, ['terms', 'hits', 'mechanicalGroups']);
  return { ...replay, scanner, grouping } as ParsedReplayShape;
}

function assertSemanticDeltaShape(value: unknown): ParsedSemanticShape {
  const semantic = assertRecord(value);
  assertExactKeys(semantic, [
    'investigationRoleResults',
    'scanSaturationDecision',
    'floorOverflowDecision',
    'semanticGroupDecisions',
    'finalGroupRoot',
    'dispositions',
    'whyOverlays',
    'knowledgeReuseDecisions',
    'exceptions',
    'investigationRequirements',
    'assuranceFacts',
  ]);
  return semantic as ParsedSemanticShape;
}

function assertDerivedCommitmentsShape(value: unknown): void {
  const derived = assertRecord(value);
  assertExactKeys(derived, [
    'coverageRoot',
    'zeroHitTermIds',
    'finalGroupCount',
  ]);
}

function normalizeAuthoringIdentity(
  state: InvestigationAuthoringState,
): ManifestIdentity {
  const record = assertRecord(state);
  assertExactKeys(
    record,
    state.applicabilityKind === 'ordinary'
      ? [
          'schemaVersion',
          'applicabilityKind',
          'repositoryId',
          'changeId',
          'investigationId',
          'normalizedIntent',
          'authoring',
          'ordinary',
        ]
      : [
          'schemaVersion',
          'applicabilityKind',
          'repositoryId',
          'changeId',
          'investigationId',
          'normalizedIntent',
          'authoring',
          'exemption',
        ],
  );
  if (record.schemaVersion !== 1) {
    throw unrepresentable('Authoring-state schema is malformed.');
  }
  const normalizedIntent = normalizeIntent(record.normalizedIntent);
  return {
    schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
    kind: INVESTIGATION_MANIFEST_V3_KIND,
    repositoryId: boundedText(record.repositoryId, 'repository ID'),
    changeId: boundedText(record.changeId, 'change ID'),
    investigationId: boundedText(record.investigationId, 'investigation ID'),
    normalizedIntent,
    intentDigest: digest(normalizedIntent),
    authoring: normalizeAuthoring(record.authoring),
  };
}

function parseManifestIdentity(
  record: Record<string, unknown>,
): ManifestIdentity {
  if (
    record.schemaVersion !== INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION ||
    record.kind !== INVESTIGATION_MANIFEST_V3_KIND
  ) {
    throw unrepresentable('Manifest v3 identity is malformed.');
  }
  const normalizedIntent = normalizeIntent(record.normalizedIntent);
  assertDigest(record.intentDigest);
  if (record.intentDigest !== digest(normalizedIntent)) {
    throw new ManifestValidationError(
      'TERM_INTEGRITY_MISMATCH',
      'Tracked normalized intent does not match intentDigest.',
    );
  }
  return {
    schemaVersion: INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
    kind: INVESTIGATION_MANIFEST_V3_KIND,
    repositoryId: boundedText(record.repositoryId, 'repository ID'),
    changeId: boundedText(record.changeId, 'change ID'),
    investigationId: boundedText(record.investigationId, 'investigation ID'),
    normalizedIntent,
    intentDigest: record.intentDigest as string,
    authoring: normalizeAuthoring(record.authoring),
  };
}

function normalizeIntent(value: unknown): NormalizedChangeIntent {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'summary',
    'sourceRefs',
    'explicitPaths',
    'explicitSymbols',
    'explicitConfigKeys',
    'renamePairs',
  ]);
  if (record.schemaVersion !== 1) {
    throw unrepresentable('Normalized intent schema is malformed.');
  }
  const sourceRefs = normalizeSourceReferences(record.sourceRefs);
  const explicitPaths = normalizeTextArray(record.explicitPaths);
  const explicitSymbols = normalizeTextArray(record.explicitSymbols);
  const explicitConfigKeys = normalizeTextArray(record.explicitConfigKeys);
  if (!Array.isArray(record.renamePairs)) {
    throw unrepresentable('Normalized intent rename pairs are malformed.');
  }
  const renamePairs = record.renamePairs.map((value) => {
    const pair = assertRecord(value);
    assertExactKeys(pair, ['from', 'to']);
    const from = boundedText(pair.from, 'rename source');
    const to = boundedText(pair.to, 'rename target');
    if (from === to) {
      throw unrepresentable('Normalized intent rename is a no-op.');
    }
    return { from, to };
  });
  assertUnique(
    renamePairs.map((pair) => canonicalJson(pair)),
    'rename pairs',
  );
  return {
    schemaVersion: 1,
    summary: boundedText(record.summary, 'intent summary'),
    sourceRefs,
    explicitPaths,
    explicitSymbols,
    explicitConfigKeys,
    renamePairs,
  };
}

function normalizeSourceReferences(value: unknown): `SRC-${string}`[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== 'string' || !/^SRC-[0-9a-f]{64}$/.test(entry),
    )
  ) {
    throw unrepresentable('Governance Source reference array is malformed.');
  }
  const sourceRefs = value as `SRC-${string}`[];
  const sorted = [...sourceRefs].sort((left, right) =>
    left.localeCompare(right),
  );
  if (canonicalJson(sourceRefs) !== canonicalJson(sorted)) {
    throw unrepresentable('Governance Source references are not canonical.');
  }
  assertUnique(sourceRefs, 'Governance Source references');
  return [...sourceRefs];
}

function normalizeAuthoring(value: unknown): {
  sessionRevision: number;
  sessionSnapshotDigest: string;
} {
  const record = assertRecord(value);
  assertExactKeys(record, ['sessionRevision', 'sessionSnapshotDigest']);
  if (
    !Number.isSafeInteger(record.sessionRevision) ||
    (record.sessionRevision as number) < 0
  ) {
    throw unrepresentable('Authoring session revision is malformed.');
  }
  assertDigest(record.sessionSnapshotDigest);
  return {
    sessionRevision: record.sessionRevision as number,
    sessionSnapshotDigest: record.sessionSnapshotDigest as string,
  };
}

function normalizeBaseline(value: unknown): InvestigationV3Baseline {
  const record = assertRecord(value);
  assertExactKeys(record, ['commitOid', 'treeOid']);
  assertGitObjectId(record.commitOid);
  assertGitObjectId(record.treeOid);
  if (
    (record.commitOid as string).length !== (record.treeOid as string).length
  ) {
    throw unrepresentable('Baseline object formats disagree.');
  }
  return {
    commitOid: record.commitOid as string,
    treeOid: record.treeOid as string,
  };
}

function assertIntentFloor(
  intent: NormalizedChangeIntent,
  canonicalTerms: PreviewInvestigationTerm[],
): void {
  const terms = new Map(canonicalTerms.map((term) => [term.termId, term]));
  const required = [
    ...intent.explicitPaths.map((value) => ({
      kind: 'literal-path' as const,
      value,
    })),
    ...intent.explicitSymbols.map((value) => ({
      kind: 'symbol' as const,
      value,
    })),
    ...intent.explicitConfigKeys.map((value) => ({
      kind: 'config-key' as const,
      value,
    })),
    ...intent.renamePairs.flatMap(({ from, to }) => [
      { kind: 'literal-content' as const, value: from },
      { kind: 'literal-content' as const, value: to },
    ]),
  ];
  for (const input of required) {
    const expected = normalizeInvestigationTerm(input);
    const actual = terms.get(expected.termId);
    if (
      actual === undefined ||
      !actual.provenance.some(({ source }) => source === 'engine')
    ) {
      throw new ManifestValidationError(
        'TERM_INTEGRITY_MISMATCH',
        `Normalized intent floor term is missing: ${input.kind}.`,
      );
    }
  }
}

function parseApproval(value: unknown): InvestigationApprovalV3 {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'investigationTargetDigest',
    'semanticAuthor',
    'approvalProvenanceDigest',
    'semanticAssurance',
    'sealDigest',
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-approval' ||
    record.semanticAssurance !== SEMANTIC_ASSURANCE
  ) {
    throw unrepresentable('Investigation approval identity is malformed.');
  }
  assertDigest(record.investigationTargetDigest);
  assertDigest(record.approvalProvenanceDigest);
  assertDigest(record.sealDigest);
  return {
    schemaVersion: 1,
    kind: 'investigation-approval',
    investigationTargetDigest: record.investigationTargetDigest as string,
    semanticAuthor: normalizeSemanticAuthor(record.semanticAuthor),
    approvalProvenanceDigest: record.approvalProvenanceDigest as string,
    semanticAssurance: SEMANTIC_ASSURANCE,
    sealDigest: record.sealDigest as string,
  };
}

function assertManifestTop(value: unknown): Record<string, unknown> {
  const record = assertRecord(value);
  assertExactKeys(record, [
    'schemaVersion',
    'kind',
    'repositoryId',
    'changeId',
    'investigationId',
    'normalizedIntent',
    'intentDigest',
    'authoring',
    'applicability',
    'investigationApproval',
    'manifestDigest',
  ]);
  return record;
}

function assertDraftShape(
  value: unknown,
): asserts value is InvestigationManifestDraftV3 {
  const record = assertManifestTop(value);
  if (
    record.schemaVersion !== INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION ||
    record.kind !== INVESTIGATION_MANIFEST_V3_KIND ||
    record.investigationApproval !== null ||
    record.manifestDigest !== null
  ) {
    throw unrepresentable('Investigation draft identity is malformed.');
  }
  parseManifestIdentity(record);
}

function investigationTargetDigest(
  manifest: ManifestIdentity,
  applicabilityContentDigest: string,
): string {
  return digestWithDomain('investigation-target/v3', {
    schemaVersion: manifest.schemaVersion,
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    intentDigest: manifest.intentDigest,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    applicabilityContentDigest,
  });
}

function failureCode(error: unknown): InvestigationV3FailureCode {
  if (error instanceof ManifestValidationError) return error.code;
  if (
    error instanceof WorkflowError &&
    isSafeInvestigationV3FailureCode(error.code)
  ) {
    return error.code;
  }
  return 'RECONSTRUCTION_MISMATCH';
}

function isSafeInvestigationV3FailureCode(
  value: unknown,
): value is InvestigationV3FailureCode {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value) <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}

function blocked(
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'],
  candidate: unknown,
  error: unknown,
): { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  return blockedWithCode(
    attemptedTransition,
    candidate,
    failureCode(error),
    error instanceof Error
      ? error.message
      : 'Unknown v3 investigation failure.',
    error instanceof WorkflowError ? error.details : undefined,
  );
}

function blockedWithCode(
  attemptedTransition: InvestigationV3Blocker['attemptedTransition'],
  candidate: unknown,
  code: InvestigationV3FailureCode,
  message: string,
  details?: Record<string, unknown>,
): { outcome: 'blocked'; blocker: InvestigationV3Blocker } {
  const candidateDigest = safeCandidateDigest(candidate);
  const detailsDigest = digest({ code, message, details: details ?? null });
  const missingAssuranceFacts = missingAssuranceFactsFor(code);
  const identityInput = {
    attemptedTransition,
    candidateDigest,
    failureCode: code,
    detailsDigest,
    missingAssuranceFacts,
  };
  return {
    outcome: 'blocked',
    blocker: {
      schemaVersion: 1,
      kind: 'investigation-v3-failure',
      failureIdentity: digestWithDomain(
        'investigation-v3-failure/v1',
        identityInput,
      ),
      ...identityInput,
    },
  };
}

function safeCandidateDigest(value: unknown): string {
  try {
    return digestWithDomain('investigation-v3-candidate/v1', value);
  } catch {
    return digestWithDomain('investigation-v3-candidate/v1', 'unrepresentable');
  }
}

function missingAssuranceFactsFor(code: string): string[] {
  switch (code) {
    case 'TERM_INTEGRITY_MISMATCH':
      return ['canonical-term-composition'];
    case 'REPLAY_INPUT_MISSING':
    case 'REPLAY_CLOSURE_UNSUPPORTED':
      return ['pinned-git-replay'];
    case 'SEMANTIC_COMPLETENESS_FAILURE':
      return ['complete-semantic-decisions'];
    case 'SOURCE_ANCHOR_UNRESOLVED':
      return ['resolvable-source-anchors'];
    case 'REVIEW_TARGET_STALE':
      return ['current-authority-snapshot'];
    default:
      return [];
  }
}

export {
  assertInvestigationRequirementV3,
  normalizeInvestigationRequirementsV3,
} from './investigation-manifest-requirements.ts';
export type {
  InvestigationGenericRequirementV3,
  InvestigationImplementationPlannedMutationV3,
  InvestigationImplementationReconciliationPayloadV3,
  InvestigationImplementationReconciliationRequirementV3,
  InvestigationPlanReviewCoveragePayloadV3,
  InvestigationPlanReviewCoverageRequirementV3,
  InvestigationPlanReviewCoverageTargetBindingV3,
  InvestigationPlanReviewCoverageTargetV3,
  InvestigationRequirementV3,
  InvestigationSemanticReuseCoverageV3,
} from './investigation-requirement-types.ts';
