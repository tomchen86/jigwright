import type { GovernanceFindingContextV1 } from '../modules/governance-intake/governance-intake.ts';
/** Binds intake workflows to existing primitive services and physical observers. */
import {
  createGovernanceIntakeWorkflow,
  createGovernanceIntakeCountInspector,
  type GovernanceIntakeWorkflowOptions as WorkflowOptions,
} from '../application/governance-intake/governance-intake-workflow.ts';
export { GovernanceIntakeTextError } from '../application/governance-intake/governance-intake-workflow.ts';
export { INTAKE_KINDS } from '../modules/governance-intake/intake-policy.ts';
import {
  captureGovernanceSource,
  listGovernanceSources,
  readGovernanceSource,
} from './governance-sources-production.ts';
import {
  convertGovernanceFinding,
  linkGovernanceFinding,
  listGovernanceFindings,
  recordGovernanceFinding,
} from './governance-findings-production.ts';
import {
  applyWorkItemReview,
  attachSourceToWorkItem,
  assertOrdinaryWorkRegistryTransition,
  createWorkItem,
  correctWorkItemSource,
  createWorkItemAfterExactSourceTextRecheck,
  ensureWorkItemPromotionChangeDirectory,
  ensureWorkItemPromotionSurveyBinding,
  ensureFindingConversionWorkItem,
  hasExactCurrentWorkItemPromotion,
  prepareWorkItemPromotionSurvey,
  promoteWorkItem,
  listWorkItems,
  findWorkItemsByExactSourceText,
  showWorkItem,
} from './work-registry-production.ts';
import { workRegistryQueries } from './work-registry-read-production.ts';
import {
  resolveTaskScope,
  resolveGovernanceIntakeRuntimeRoot,
  assertExistingGovernanceIntakeChange,
} from '../runtime/repository-observation/governance-intake-context.ts';
export {
  resolveGovernanceIntakeRuntimeRoot,
  resolveRepositoryFindingScope,
  resolveActiveSession,
} from '../runtime/repository-observation/governance-intake-context.ts';
import { productionChangeRoutingInspector } from './change-routing-observation-production.ts';
import { loadChangeContract as productionChangeContractReader } from './consumer-contract-production.ts';
import { renderHandoff as renderHandoffWithContractReader } from '../adapters/consumer/repository/handoff/handoff.ts';
import { repositoryHandoffRelativePath } from '../runtime/workflow-configuration/workflow-configuration.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
export function renderGovernanceIntakeHandoff(repositoryRoot: string): string {
  renderHandoff(repositoryRoot);
  return repositoryHandoffRelativePath(repositoryRoot);
}
export function createGovernanceIntakeWorkflowForCommand(
  options: GovernanceIntakeWorkflowOptions = {},
) {
  return createGovernanceIntakeWorkflow(
    {
      sources: {
        captureGovernanceSource,
        listGovernanceSources,
        readGovernanceSource,
      },
      findings: {
        convertGovernanceFinding,
        linkGovernanceFinding,
        listGovernanceFindings,
        recordGovernanceFinding,
      },
      writes: {
        applyWorkItemReview,
        attachSourceToWorkItem,
        assertOrdinaryWorkRegistryTransition,
        createWorkItem,
        correctWorkItemSource,
        createWorkItemAfterExactSourceTextRecheck,
        ensureWorkItemPromotionChangeDirectory,
        ensureWorkItemPromotionSurveyBinding,
        ensureFindingConversionWorkItem,
        hasExactCurrentWorkItemPromotion,
        prepareWorkItemPromotionSurvey,
        promoteWorkItem,
      },
      queries: { listWorkItems, findWorkItemsByExactSourceText, showWorkItem },
      context: {
        taskScope: options.resolveTaskScope ?? resolveTaskScope,
        runtimeRoot:
          options.resolveRuntimeRoot ?? resolveGovernanceIntakeRuntimeRoot,
        existingChange: assertExistingGovernanceIntakeChange,
      },
      now: () => new Date().toISOString(),
    },
    options,
  );
}
export const inspectGovernanceIntakeCounts =
  createGovernanceIntakeCountInspector({
    queries: workRegistryQueries,
    findings: { listGovernanceFindings },
  });

export type GovernanceIntakeWorkflowOptions = WorkflowOptions &
  Readonly<{
    resolveSession?: (
      cwd: string,
      sessionId: string,
    ) => GovernanceFindingContextV1;
    resolveRuntimeRoot?: (cwd: string) => string;
    resolveRepositoryScope?: (cwd: string) => GovernanceFindingContextV1;
    resolveTaskScope?: (cwd: string) => GovernanceFindingContextV1 | null;
  }>;
