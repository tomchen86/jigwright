/** Durable open-task phase and status values shared by activation and status queries. */
export type OpenTaskPhase =
  'prepared' | 'plan-committed' | 'session-active' | 'completed';

export type OpenTaskLifecycleStatus = Readonly<{
  kind: 'open-task-lifecycle-status.v1';
  state:
    | 'opening'
    | 'active'
    | 'revising'
    | 'committed'
    | 'aborted'
    | 'recovery-required';
  lastDurablePhase: OpenTaskPhase;
  transactionId: string;
  changeId: string;
  taskId: string;
  mandateTaskId: string | null;
  sessionId: string;
  parentCommit: string;
  planningCommit: string;
  baselineTree: string;
  reportId: string;
  retrySafe: boolean;
  recoveryCommand: string | null;
  errorCode: string | null;
}>;
