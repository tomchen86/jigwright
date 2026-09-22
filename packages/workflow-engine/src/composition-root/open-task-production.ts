import { taskMandateOperations } from './task-mandate-production.ts';
import { planningTransitionExecution as planningExecution } from './planning-execution-epoch-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import { handoffDocuments } from './handoff-production.ts';
import { ciPlanningReplay } from './ci-replay-production.ts';
import { managedDocuments } from './managed-documents-production.ts';
import { loadChangeContract } from './consumer-contract-production.ts';
import { planningDraftWorkspace } from './planning-workspace-production.ts';
/**
 * Supplies system document context to task activation and journal recovery.
 *
 * Invariants:
 * - The wrapper forwards task identifiers and options while fixing the
 *   document reader to taskSystemDocumentContext.
 */
import {
  openTaskWithPorts,
  type OpenTaskOptions,
} from '../application/execute-task/open-task.ts';
import { taskSystemDocumentContext } from '../runtime/managed-documents/validation/task-system-document-context.ts';

export function openTask(
  cwd: string,
  requestedChangeId: string,
  requestedTaskId: string | undefined,
  requestedMandateTaskId?: string,
  options: OpenTaskOptions = {},
) {
  return openTaskWithPorts(
    {
      planningExecution,
      planningReplay: ciPlanningReplay,
      taskMandate: taskMandateOperations,
      changeContract: productionChangeContract,
      handoffDocuments,
      managedDocuments,
      loadChangeContract,
      readSystemDocuments: taskSystemDocumentContext,
      planningWorkspace: planningDraftWorkspace,
    },
    cwd,
    requestedChangeId,
    requestedTaskId,
    requestedMandateTaskId,
    options,
  );
}
