/** Canonical investigation evidence DTOs, independent of materialization and normalization. */
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';

type InvestigationRequirementMetadataV3 = {
  requirementId: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

export type InvestigationGenericRequirementV3 =
  InvestigationRequirementMetadataV3 & {
    /** Optional only while existing generic authoring callers move to tags. */
    kind?: 'investigation-requirement';
    text: string;
  };

export type InvestigationPlanReviewCoverageTargetV3 = {
  targetId: string;
  stratum:
    | 'planned-mutation'
    | 'hard-risk'
    | 'largest-blast-radius'
    | 'degraded-extraction'
    | 'unresolved-uncertainty'
    | 'production-consumer'
    | 'test-or-mirror'
    | 'contract-or-schema'
    | 'cli-or-integration'
    | 'cross-module';
  reusedFromLedger: boolean;
};

export type InvestigationPlanReviewCoverageTargetBindingV3 =
  InvestigationPlanReviewCoverageTargetV3 & {
    source:
      'planned-mutation' | 'investigation-target' | 'carried-ledger-subject';
    path: string;
    targetDigest: string;
    evidenceKind: 'planning-or-repository-location';
    subjectId: string | null;
    ledgerEntryId: string | null;
    invariants: readonly string[];
    riskFactors: readonly string[];
    freshness: string;
    evidenceMode: 'bounded-context' | 'full-blob';
    degradedExtraction: boolean;
    cost: { rawBytes: number; reviewUnits: number };
  };

export type InvestigationSemanticReuseCoverageV3 = {
  schemaVersion: 1;
  kind: 'semantic-reuse-coverage';
  owedCount: number;
  carriedCount: number;
  carried: readonly {
    manifestEntryId: string;
    subjectId: string;
    ledgerEntryId: string;
  }[];
  resolutions: readonly {
    subjectId: string;
    resolution: string;
    state: string;
  }[];
  reviewTargets: readonly InvestigationPlanReviewCoverageTargetV3[];
};

export type InvestigationPlanReviewCoveragePayloadV3 = {
  schemaVersion: 2;
  kind: 'plan-review-coverage-requirement';
  activation: 'global';
  investigationId: string;
  changeId: string;
  baselineCommit: string;
  baselineTree: string;
  coverageTier: 'standard' | 'elevated' | 'critical';
  sealedSamplingSeed: string;
  coveragePolicyDigest: string;
  manifest: {
    schemaVersion: 1;
    kind: 'review-coverage-manifest';
    tier: 'standard' | 'elevated' | 'critical';
    targets: readonly InvestigationPlanReviewCoverageTargetV3[];
    populationDigest: string;
  };
  requiredTargetIds: readonly string[];
  targetBindings: readonly InvestigationPlanReviewCoverageTargetBindingV3[];
  semanticReuse: InvestigationSemanticReuseCoverageV3;
  costProfile: {
    targetCount: number;
    rawBytes: number;
    reviewUnits: number;
  };
};

export type InvestigationPlanReviewCoverageRequirementV3 =
  InvestigationRequirementMetadataV3 & {
    kind: 'plan-review-coverage-requirement';
    coverage: InvestigationPlanReviewCoveragePayloadV3;
  };

export type InvestigationImplementationPlannedMutationV3 = {
  subjectId: string;
  path: string;
  intendedChange: string;
  invariantsToPreserve: readonly string[];
};

export type InvestigationImplementationReconciliationPayloadV3 = {
  schemaVersion: 1;
  kind: 'implementation-reconciliation-requirement';
  changeId: string;
  baseline: { head: string; tree: string };
  policyDigest: string;
  plannedMutations: readonly InvestigationImplementationPlannedMutationV3[];
};

export type InvestigationImplementationReconciliationRequirementV3 =
  InvestigationRequirementMetadataV3 & {
    kind: 'implementation-reconciliation-requirement';
    reconciliation: InvestigationImplementationReconciliationPayloadV3;
  };

export type InvestigationRequirementV3 =
  | InvestigationGenericRequirementV3
  | InvestigationPlanReviewCoverageRequirementV3
  | InvestigationImplementationReconciliationRequirementV3;
