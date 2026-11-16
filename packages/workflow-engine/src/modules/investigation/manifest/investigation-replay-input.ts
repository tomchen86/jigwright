/** Canonical investigation value contracts, separate from replay and repository observation. */
import type { MutationClassPolicy } from '../../source/mutation-class-policy.ts';
import type { InvestigationSemanticAuthor } from '../domain/investigation-applicability.ts';
import type {
  InvestigationDispositionDecision,
  InvestigationSemanticGroupDecision,
} from '../domain/investigation-domain.ts';
import type {
  DeclaredInvestigationRoot,
  ReviewedPathRelationship,
} from '../domain/investigation-groups.ts';
import type {
  InvestigationLimits,
  InvestigationTermContribution,
  PreviewInvestigationTerm,
} from '../domain/investigation-terms.ts';
import type { InvestigationV3Baseline } from './investigation-baseline.ts';

export type InvestigationScanSaturationDecision = {
  saturatedTermIds: string[];
  acknowledgeIncompleteScan: true;
  rationale: string;
  semanticAuthor: InvestigationSemanticAuthor;
  provenanceDigest: string;
};

export type InvestigationReplayAuthoringInput = {
  baseline: InvestigationV3Baseline;
  termContributions: InvestigationTermContribution[];
  canonicalTerms: PreviewInvestigationTerm[];
  scanner: {
    limits?: InvestigationLimits;
    allowSaturatedTerms: boolean;
    saturationDecision: InvestigationScanSaturationDecision | null;
  };
  grouping: {
    mutationPolicy: MutationClassPolicy;
    declaredRoots: DeclaredInvestigationRoot[];
    reviewedRelationships: ReviewedPathRelationship[];
  };
  semanticGroupDecisions: InvestigationSemanticGroupDecision[];
  dispositionDecisions: InvestigationDispositionDecision[];
};
