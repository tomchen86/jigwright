/** Durable planning report IO; validation is owned by the planning domain. */
import { isEngineProjectionPathForTransition } from '../../modules/projection/engine-projection-registry.ts';

const isPlanProjectionPath = (candidate: string) =>
  isEngineProjectionPathForTransition(candidate, 'plan');
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
  assertPlanningTransitionReport(report, isPlanProjectionPath);
  return writeContentRecord(directory, report);
}

export function readPlanningTransitionReport(
  directory: string,
  reportId: string,
): PlanningTransitionReport {
  const report = readContentRecord(directory, reportId);
  assertPlanningTransitionReport(report, isPlanProjectionPath);
  return report;
}
