/** Required repository observations, invoked at each epoch admission phase. */
import type { CommitFacts } from '../repository-consumer/commit-facts.ts';
import type { PlanningTransitionReport } from './planning-transition-report.ts';
import type { TaskExecutionGenerationReader } from '../assurance/task-execution-evidence.ts';
export type PlanningExecutionEpochObservations = Readonly<{
  resolveEnvironment(cwd: string): {
    repositoryRoot: string;
    changeRoot: string;
    storeRoot: string;
  };
  readFirstParentCommits(repositoryRoot: string, tip: string): string[];
  readCommitFacts(repositoryRoot: string, commitHash: string): CommitFacts;
  readReportEntries(reportsDirectory: string): string[];
  readPlanningTransitionReport(
    reportsDirectory: string,
    reportId: string,
  ): PlanningTransitionReport;
  taskExecutionGeneration: TaskExecutionGenerationReader;
}>;
