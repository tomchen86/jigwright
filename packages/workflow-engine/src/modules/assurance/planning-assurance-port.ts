/** Required planning assurance evaluation supplied by application composition. */
import type { ChangeContract } from '../planning-provider/change-contract.ts';
import type {
  PlanningAssuranceBinding,
  PlanningAssuranceSummary,
} from './planning-assurance-binding.ts';
import type {
  InvestigationFirstPlanningSubject,
  InvestigationFirstPlanningReadiness,
} from './planning-assurance-validator.ts';
import type { ConsumedRoleReplayPort } from '../provider-orchestration/role-admission-contracts.ts';
export type PlanningAssurancePort = Readonly<{
  createTaskBinding(
    contract: ChangeContract,
    summary: PlanningAssuranceSummary | null,
  ): PlanningAssuranceBinding | null;
  deriveSubject(
    repositoryRoot: string,
    contract: ChangeContract,
  ): InvestigationFirstPlanningSubject;
  validateReadiness(
    repositoryRoot: string,
    contract: ChangeContract,
    consumedPlanReviewReplay: ConsumedRoleReplayPort,
  ): InvestigationFirstPlanningReadiness;
}>;
