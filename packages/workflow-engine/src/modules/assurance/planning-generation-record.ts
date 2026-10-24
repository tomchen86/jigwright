import type { InvestigationBaseline } from '../investigation/domain/investigation-applicability.ts';
/** Canonical planning generation record data; parsing and effects stay with their existing implementation. */
import type { InvestigationRequirementV3 } from '../investigation/manifest/investigation-requirement-types.ts';

export type PlanningInvestigationDependency = {
  role: string;
  nodeId: string;
  resultDigest: string;
};

export type PlanningInvestigationRequirement = InvestigationRequirementV3;

export type PlanningPolicyDigests = {
  planningPolicyDigest: string;
  canonicalizerPolicyDigest: string;
  rendererPolicyDigest: string;
  reviewPolicyDigest: string;
};

export type PlanningGeneration = {
  schemaVersion: 1;
  planningGenerationId: string;
  targetDigest: string;
  manifestDigest: string;
  investigationTargetDigest: string;
  investigationBaseline: InvestigationBaseline;
  investigationDependencies: PlanningInvestigationDependency[];
  investigationRequirements: PlanningInvestigationRequirement[];
  policies: PlanningPolicyDigests;
};
