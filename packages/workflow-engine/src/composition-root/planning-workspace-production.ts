import { openSpecPlanningPathAdmission } from '../adapters/planning/openspec/documents/planning-path-policy.ts';
/** Binds planning workspaces to the validated current Work Registry origin reader. */
import { createPlanningDraftWorkspaceService } from '../runtime/session-workspace/planning-workspace.ts';
import { workRegistryQueries } from './work-registry-read-production.ts';
export const planningDraftWorkspace = createPlanningDraftWorkspaceService(
  workRegistryQueries.readCurrentChangeOrigin,
  openSpecPlanningPathAdmission,
);
export const {
  preparePlanningDraftWorkspace,
  readPlanningDraftWorkspace,
  inspectPlanningDraftWorkspace,
} = planningDraftWorkspace;
