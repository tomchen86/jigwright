/** Observed session facts consumed by lifecycle rules and report validation. */
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { WorkflowSession } from './workflow-session-contract.ts';
import type { ValidatedChangeContract } from '../planning-provider/validated-change-contract.ts';
import type { TaskPolicy } from '../planning-provider/planning-artifact-types.ts';
export type SessionInspection = {
  git: GitState;
  session: WorkflowSession;
  contract: ValidatedChangeContract;
  policy: TaskPolicy;
  artifactDigests: Record<string, string>;
  changedPaths: string[];
  unexpectedPaths: string[];
  fingerprint: string;
  tasksPath: string;
  baselineTasks: string;
};
