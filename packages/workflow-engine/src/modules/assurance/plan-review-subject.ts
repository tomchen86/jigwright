/** Canonical plan review subject data; parsing and effects stay with their existing implementation. */
import type { IndependenceDimension } from '../provider-orchestration/role-independence.ts';
import type { PlanningGeneration } from './planning-generation-record.ts';

export type PlanReviewSubjectInput = {
  generation: PlanningGeneration;
  reviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
};

export type PlanReviewSubject = {
  schemaVersion: 1;
  subjectDigest: string;
  planningGenerationId: string;
  planTargetDigest: string;
  manifestDigest: string;
  investigationTargetDigest: string;
  reviewPolicyDigest: string;
  requiredIndependence: IndependenceDimension;
  investigationBaseline: { head: string; tree: string };
  investigationDependencies: Array<{
    role: string;
    nodeId: string;
    resultDigest: string;
  }>;
  investigationRequirements: PlanningGeneration['investigationRequirements'];
};
