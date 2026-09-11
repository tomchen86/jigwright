/** Admitted change facts shared by planning, execution and report validation. */
import type { ChangeContract, ManagedSchemaName } from './change-contract.ts';
import type { PlanningProviderDiagnostic } from '@jigwright/core/planning-provider-port';
import type { ResolvedPlanningProviderBinding } from '@jigwright/core/planning-provider-binding';
import type { PlanningAssuranceSummary as InvestigationFirstPlanningAssuranceSummary } from '../assurance/planning-assurance-binding.ts';
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
