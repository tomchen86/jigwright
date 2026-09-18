/** Admitted change facts shared by planning, execution and report validation. */
import type {
  ChangeContract,
  ManagedSchemaName,
} from '../planning-provider/change-contract.ts';
import type { PlanningProviderDiagnostic } from '@jigwright/core/planning-provider-port';
import type { ResolvedPlanningProviderBinding } from '@jigwright/core/planning-provider-binding';
import type { PlanningAssuranceSummary as InvestigationFirstPlanningAssuranceSummary } from './planning-assurance-binding.ts';
import type { PlanningAssurancePort } from './planning-assurance-port.ts';
import type { ConsumedRoleReplayPort } from '../provider-orchestration/role-admission-contracts.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { PlanningPathPolicy } from '../source/planning-paths.ts';
import type { SystemDescriptionSnapshot } from '../source/spec-ownership.ts';
export type ManagedChangeDiagnostic = PlanningProviderDiagnostic;

export type ValidatedChangeContract = ChangeContract & {
  schemaName: ManagedSchemaName;
  openspec: {
    version: '1.6.0';
    schemaName: ManagedSchemaName;
    statusComplete: true;
    validationValid: true;
  };
  diagnostics: ManagedChangeDiagnostic[];
  artifactModes: Record<string, '100644' | '100755'>;
  contractDigest: string;
  planningAssurance: InvestigationFirstPlanningAssuranceSummary | null;
  planningProvider: ResolvedPlanningProviderBinding;
};

/**
 * Loads a validated change contract after proving the validation left the
 * repository projection unchanged. Implementations belong to composition.
 */
export type StableValidatedChangeContractLoader = (
  initialGit: GitState,
  changeId: string,
) => {
  git: GitState;
  contract: ValidatedChangeContract;
  consumedPlanReviewReplay: ConsumedRoleReplayPort;
  planningAssurance: PlanningAssurancePort;
  planningPaths: PlanningPathPolicy;
  readSystemDescription(): SystemDescriptionSnapshot;
};
