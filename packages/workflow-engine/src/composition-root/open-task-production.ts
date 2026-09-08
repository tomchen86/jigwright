/** Supplies pinned document reads to initial task activation and journal recovery. */
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
    { readSystemDocuments: taskSystemDocumentContext },
    cwd,
    requestedChangeId,
    requestedTaskId,
    requestedMandateTaskId,
    options,
  );
}
