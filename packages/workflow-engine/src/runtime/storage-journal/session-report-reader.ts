/** Reads a session-bound immutable report from its runtime workspace. */
import type { WorkflowReport } from '../../modules/lifecycle/workflow-report.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { readImmutableReport } from './report-store.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';

export function readSessionReport(
  inspection: SessionInspection,
  reportId: string,
): WorkflowReport {
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  return readImmutableReport(
    runtime.reports,
    inspection.session.sessionId,
    reportId,
  );
}
