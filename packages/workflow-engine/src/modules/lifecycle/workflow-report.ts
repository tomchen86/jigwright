/** Complete workflow report contract shared by lifecycle policy and durable storage. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { PlanningAssuranceBinding } from '../assurance/planning-assurance-binding.ts';

export type WorkflowReport = {
  schemaVersion: 1;
  kind:
    | 'check'
    | 'completion'
    | 'finish'
    | 'commit'
    | 'authority-check'
    | 'implementation-reconciliation';
  sessionId: string;
  changeId: string;
  taskId: string;
  createdAt: string;
  parentReportId?: string;
  planningAssurance?: PlanningAssuranceBinding | null;
  [key: string]: unknown;
};

export function staleReport(code: string) {
  return workflowError(
    code,
    'The workflow report no longer matches the exact repository projection.',
    ExitCode.staleState,
  );
}
