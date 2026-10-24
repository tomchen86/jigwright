/** Result data for an exact planning transition; transaction execution has a separate owner. */
import type { ArchiveApplicabilityRecord } from './planning-transition-report.ts';
import type { InvestigationFirstPlanningAssuranceSummary } from '../assurance/planning-assurance-validator.ts';
export type PlanningTransitionResult = {
  changeId: string;
  kind: 'introduction' | 'revision';
  /** Present when this transition was an amendment rather than a plan. */
  amendment?: {
    reason: string;
    executionImpact: 'none' | 'required';
    rationale: string;
    decisionDigest: string;
    reopenedTasks: string[];
    planningGeneration: string;
    amendsPlanningGeneration: string;
    planReview: string;
  };
  subject: string;
  baselineHead: string;
  changedPaths: string[];
  stagedPaths: string[];
  tree: string;
  commitHash: string;
  reportId: string;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
  archiveApplicability: ArchiveApplicabilityRecord;
};
