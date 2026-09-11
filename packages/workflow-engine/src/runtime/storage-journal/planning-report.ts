/** Durable planning report IO; validation is owned by the planning domain. */
import {
  readContentRecord,
  writeContentRecord,
} from './content-record-store.ts';
import {
  assertPlanningTransitionReport,
  type PlanningTransitionReport,
} from '../../modules/lifecycle/planning-transition-report.ts';

export function writePlanningTransitionReport(
  directory: string,
  report: PlanningTransitionReport,
): string {
  assertPlanningTransitionReport(report);
  return writeContentRecord(directory, report);
}

export function readPlanningTransitionReport(
  directory: string,
  reportId: string,
): PlanningTransitionReport {
  const report = readContentRecord(directory, reportId);
  assertPlanningTransitionReport(report);
  return report;
}
