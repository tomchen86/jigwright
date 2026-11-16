/** Canonical investigation value contracts, separate from replay and repository observation. */
import type { NormalizedChangeIntent } from '../../source/change-intent.ts';
import type { MutationClassPolicy } from '../../source/mutation-class-policy.ts';
import type { FloorOverflowDecision } from '../domain/floor-overflow-pruning.ts';
import type {
  InvestigationChangeClass,
  InvestigationExemptionCategory,
  InvestigationSemanticAuthor,
} from '../domain/investigation-applicability.ts';
import type {
  AppliedInvestigationDisposition,
  InvestigationGroupRef,
  InvestigationSemanticGroupDecision,
} from '../domain/investigation-domain.ts';
import type {
  DeclaredInvestigationRoot,
  ReviewedPathRelationship,
} from '../domain/investigation-groups.ts';
import type {
  INVESTIGATION_MANIFEST_V3_KIND,
  INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
  INVESTIGATION_ROOT_CANONICALIZATION_VERSION,
  INVESTIGATION_TERM_NORMALIZATION_VERSION,
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  INVESTIGATION_V3_KNOWN_FAILURE_CODES,
  SEMANTIC_ASSURANCE,
} from '../domain/investigation-schema.ts';
import type {
  InvestigationLimits,
  InvestigationTermContribution,
  PreviewInvestigationTerm,
} from '../domain/investigation-terms.ts';
import type { InvestigationV3Baseline } from './investigation-baseline.ts';
import type {
  InvestigationReplayAuthoringInput,
  InvestigationScanSaturationDecision,
} from './investigation-replay-input.ts';
import type { InvestigationRequirementV3 } from './investigation-requirement-types.ts';

export type InvestigationV3RoleResult = {
  role: 'reviewer-pre-anchor' | 'investigation-reviewer';
  targetDigest: string;
  providerId: string | null;
  sessionId: string | null;
  principalId: string | null;
  requiredIndependence: string;
  achievedIndependence: string;
  requestDigest: string;
  outputDigest: string;
  contentDigest: string;
  policyDigest: string;
  provenanceDigest: string;
  grantUse: {
    kind: 'collaboration-grant-use-identity.v1';
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  } | null;
  roleContextSharingUse: {
    kind: 'role-context-sharing-use-identity.v1';
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
    useProjectionDigest: string;
    admissionDigest: string;
  } | null;
};

export type InvestigationAssuranceFacts = {
  assessmentDigest: string;
  coverageTier: 'standard' | 'elevated' | 'critical';
  escalated: boolean;
  reasons: string[];
  provenanceDigest: string;
};

export type InvestigationSourceAnchor = {
  pathIdentity: { rawBase64: string; utf8: string | null };
  blobOid: string;
  byteRange: { start: number; end: number };
  termId: string;
};

export type InvestigationWhyOverlayV3 = {
  overlayId: string;
  pathIdentity: { rawBase64: string; utf8: string | null };
  blobOid: string;
  contentSha256: string;
  groupRefs: InvestigationGroupRef[];
  anchors: InvestigationSourceAnchor[];
  why: string;
  protectedInvariant: string;
  reviewerQuestion: string;
  answer: string;
  semanticAuthor: InvestigationSemanticAuthor;
  readComplete: true;
  semanticAssurance: typeof SEMANTIC_ASSURANCE;
};

export type InvestigationKnowledgeReuseDecision = {
  decisionId: string;
  pathIdentity: { rawBase64: string; utf8: string | null };
  blobOid: string;
  knowledgeRef: {
    subjectId: string;
    versionDigest: string;
  };
  freshness: {
    decision: 'fresh';
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    provenanceDigest: string;
  };
};

export type InvestigationSemanticException = {
  exceptionId: string;
  kind: 'semantic-group' | 'disposition' | 'why' | 'knowledge-reuse';
  subjectKey: string;
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

export type CommonAuthoringState = {
  schemaVersion: 1;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  normalizedIntent: NormalizedChangeIntent;
  authoring: {
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
};

export type OrdinaryInvestigationAuthoringState = CommonAuthoringState & {
  applicabilityKind: 'ordinary';
  ordinary: InvestigationReplayAuthoringInput & {
    whyOverlays: InvestigationWhyOverlayV3[];
    knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
    investigationRoleResults: InvestigationV3RoleResult[];
    floorOverflowDecision: FloorOverflowDecision | null;
    exceptions: InvestigationSemanticException[];
    investigationRequirements: InvestigationRequirementV3[];
    assuranceFacts: InvestigationAssuranceFacts;
  };
};

export type ExemptionInvestigationAuthoringState = CommonAuthoringState & {
  applicabilityKind: 'exemption';
  exemption: {
    category: InvestigationExemptionCategory;
    baseline: InvestigationV3Baseline;
    declaredPaths: string[];
    declaredChangeClasses: InvestigationChangeClass[];
    rationale: string;
    semanticAuthor: InvestigationSemanticAuthor;
    nonTrivialBehaviorReliance: 'none-declared';
    researchBudgetMinutes: number | null;
  };
};

export type InvestigationAuthoringState =
  OrdinaryInvestigationAuthoringState | ExemptionInvestigationAuthoringState;

export type PersistedDisposition = Omit<
  AppliedInvestigationDisposition,
  'coveredHitKeys' | 'dispositionDigest'
> & {
  dispositionDigest: string;
};

export type InvestigationReplayContractV3 = {
  baseline: InvestigationV3Baseline;
  termContributions: InvestigationTermContribution[];
  canonicalTerms: PreviewInvestigationTerm[];
  termNormalizationVersion: typeof INVESTIGATION_TERM_NORMALIZATION_VERSION;
  termSetDigest: string;
  scanner: {
    evaluatorId: 'investigation-scanner.v1';
    policyDigest: string;
    canonicalizationVersion: 'investigation-scan-canonicalization.v1';
    limits: InvestigationLimits;
    allowSaturatedTerms: boolean;
  };
  grouping: {
    evaluatorId: 'investigation-groups.v1';
    policyDigest: string;
    canonicalizationVersion: 'investigation-mechanical-groups.v3';
    mutationPolicy: MutationClassPolicy;
    declaredRoots: DeclaredInvestigationRoot[];
    reviewedRelationships: ReviewedPathRelationship[];
  };
  coverage: {
    evaluatorId: 'investigation-coverage.v3';
    canonicalizationVersion: typeof INVESTIGATION_ROOT_CANONICALIZATION_VERSION;
  };
  inventoryRoot: string;
  hitRoot: string;
  mechanicalGroupRoot: string;
  counts: {
    terms: number;
    hits: number;
    mechanicalGroups: number;
  };
};

export type InvestigationSemanticDeltaV3 = {
  investigationRoleResults: InvestigationV3RoleResult[];
  scanSaturationDecision: InvestigationScanSaturationDecision | null;
  floorOverflowDecision: FloorOverflowDecision | null;
  semanticGroupDecisions: InvestigationSemanticGroupDecision[];
  finalGroupRoot: string;
  dispositions: PersistedDisposition[];
  whyOverlays: InvestigationWhyOverlayV3[];
  knowledgeReuseDecisions: InvestigationKnowledgeReuseDecision[];
  exceptions: InvestigationSemanticException[];
  investigationRequirements: InvestigationRequirementV3[];
  assuranceFacts: InvestigationAssuranceFacts;
};

export type OrdinaryInvestigationApplicabilityV3 = {
  kind: 'ordinary';
  replayContract: InvestigationReplayContractV3;
  semanticDelta: InvestigationSemanticDeltaV3;
  derivedCommitments: {
    coverageRoot: string;
    zeroHitTermIds: string[];
    finalGroupCount: number;
  };
};

export type ExemptionInvestigationApplicabilityV3 = {
  kind: 'exemption';
  category: InvestigationExemptionCategory;
  baseline: InvestigationV3Baseline;
  declaredPaths: string[];
  declaredChangeClasses: InvestigationChangeClass[];
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  nonTrivialBehaviorReliance: 'none-declared';
  researchBudgetMinutes: number | null;
  policyDigest: string;
  applicabilityDigest: string;
};

export type InvestigationApprovalV3 = {
  schemaVersion: 1;
  kind: 'investigation-approval';
  investigationTargetDigest: string;
  semanticAuthor: InvestigationSemanticAuthor;
  approvalProvenanceDigest: string;
  semanticAssurance: typeof SEMANTIC_ASSURANCE;
  sealDigest: string;
};

export type ManifestIdentity = {
  schemaVersion: typeof INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION;
  kind: typeof INVESTIGATION_MANIFEST_V3_KIND;
  repositoryId: string;
  changeId: string;
  investigationId: string;
  normalizedIntent: NormalizedChangeIntent;
  intentDigest: string;
  authoring: {
    sessionRevision: number;
    sessionSnapshotDigest: string;
  };
};

export type InvestigationManifestDraftV3 = ManifestIdentity & {
  applicability:
    | OrdinaryInvestigationApplicabilityV3
    | ExemptionInvestigationApplicabilityV3;
  investigationApproval: null;
  manifestDigest: null;
};

export type InvestigationManifestV3 = ManifestIdentity & {
  applicability:
    | OrdinaryInvestigationApplicabilityV3
    | ExemptionInvestigationApplicabilityV3;
  investigationApproval: InvestigationApprovalV3;
  manifestDigest: string;
};

export type InvestigationV3FailureCode =
  (typeof INVESTIGATION_V3_KNOWN_FAILURE_CODES)[number] | (string & {});

export type InvestigationV3Blocker = {
  schemaVersion: 1;
  kind: 'investigation-v3-failure';
  failureIdentity: string;
  attemptedTransition: (typeof INVESTIGATION_V3_ATTEMPTED_TRANSITIONS)[number];
  candidateDigest: string;
  failureCode: InvestigationV3FailureCode;
  detailsDigest: string;
  missingAssuranceFacts: string[];
};
