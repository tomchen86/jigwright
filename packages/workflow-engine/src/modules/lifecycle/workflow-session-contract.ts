/** Current durable workflow session data shared by lifecycle rules and storage. */
import type { TaskSessionReference } from '@jigwright/core/workflow-identifiers';
import type { PlanningAssuranceBinding } from '../assurance/planning-assurance-binding.ts';

export type TaskSessionResourceLease = Readonly<{
  kind: 'destructive-database' | 'exclusive';
  digest: `sha256:${string}`;
}>;

export type TaskSessionIsolationBinding = Readonly<{
  schemaVersion: 1;
  routingRole: 'single' | 'primary' | 'concurrent';
  routingWorksetDigest: `sha256:${string}`;
  concurrencyEnabled: boolean;
  worktreeDigest: `sha256:${string}`;
  resources: readonly TaskSessionResourceLease[];
}>;

export type WorkflowSession = TaskSessionReference & {
  schemaVersion: 1;
  state: 'active' | 'revising' | 'aborted' | 'committed';
  /** Durable top-level task mandate authorization for production sessions. */
  mandateBinding?: {
    schemaVersion: 1;
    mandateTaskId: string;
    mandateId: string;
    mandateDigest: string;
    changeId: string;
    externalAuditRoot: string;
  } | null;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  artifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  /** Durable worktree, workset, and exclusive-resource lease identities. */
  isolation: TaskSessionIsolationBinding;
  requiredCheckDigests: Record<string, string>;
  /** Engine identity against which the current durable check evidence ran. */
  checkEvidenceEngineDigest?: `sha256:${string}`;
  planningAssurance: PlanningAssuranceBinding | null;
  /** Current same-session planning-authority lease while execution is paused. */
  revisionLeaseId?: string;
  /** Immutable post-implementation semantic reconciliation authority. */
  implementationReconciliationReportId?: string;
  /** Exact engine-owned Git projection authorized by that reconciliation. */
  implementationReconciliationPaths?: string[];
  /** Authenticated reviewer-requested documentation paths for this session. */
  documentationRemediation?: {
    reviewRecordDigests: string[];
    paths: string[];
  };
  createdAt: string;
  latestCheckReportId?: string;
  completionReportId?: string;
  finishReportId?: string;
  commitReportId?: string;
  commitHash?: string;
  committedAt?: string;
  abortedAt?: string;
  abortReason?: string;
};
