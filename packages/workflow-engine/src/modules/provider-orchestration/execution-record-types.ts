/**
 * Defines engine Job, Attempt, failure and retry records around the shared
 * execution contracts.
 *
 * Invariants:
 * - Workflow status and blocker types alias the public core contracts
 *   instead of declaring another vocabulary.
 */
import type {
  ExecutionWorkflowStatusV2,
  ExecutionWorkflowBlockerV2,
  ExecutionWorkflowRecordV2,
} from '@jigwright/core/execution-workflow-record';
import type {
  JobStatusV2,
  SemanticJobSpecV1,
  AttemptStatusV2,
  AttemptAcceptanceBindingV1,
} from '@jigwright/core/job-attempt-runtime';
import type { ExecutionRetryPolicyV1 } from '@jigwright/core/execution-retry-policy';
import type { ExecutionPolicySnapshotV1 } from '@jigwright/core/execution-policy-snapshot';
import type { TaskMandateBinding } from '../authority/task-mandate.ts';
import type { GrantRequest } from '../authority/execution-governance.ts';
import type {
  ReadOnlyProbeKindV1,
  ReadOnlyProbeRequestV1,
} from '@jigwright/core/read-only-probe';

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Compatibility names for the public core-owned execution Workflow value. */
export type WorkflowStatus = ExecutionWorkflowStatusV2;

export type WorkflowBlocker = ExecutionWorkflowBlockerV2;

export type WorkflowRecord = ExecutionWorkflowRecordV2;

/** Compatibility name for the public core-owned V2 Job state vocabulary. */
export type JobStatus = JobStatusV2;

/** Compatibility name for the public core-owned execution retry policy. */
export type RetryPolicy = ExecutionRetryPolicyV1;

/** Compatibility name for the public core-owned V1 semantic Job value. */
export type SemanticJobSpec = SemanticJobSpecV1;

/** Compatibility name for the public core-owned V1 execution policy value. */
export type ExecutionPolicySnapshot = ExecutionPolicySnapshotV1;

export type JobRecord = {
  schemaVersion: 2;
  jobId: string;
  workflowId: string;
  epoch: number;
  /** Absent on planning-only invocations that do not execute a managed Task. */
  mandateBinding?: TaskMandateBinding;
  stage: string;
  contextDigest: string;
  requestDigest: string;
  semanticSpec: SemanticJobSpec;
  status: JobStatus;
  acceptedAttemptId: string | null;
  attemptCount: number;
  cumulativeRuntimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
  repairAttemptCount: number;
  retryPolicy: RetryPolicy;
  createdAt: string;
  updatedAt: string;
};

export type RetryMode =
  | 'same-input'
  | 'execution-policy-change'
  | 'repair'
  | 'strategy-change'
  | 'new-context'
  | 'none';

/** Compatibility name for the public core-owned V2 Attempt state vocabulary. */
export type AttemptStatus = AttemptStatusV2;

export type AttemptRetention = 'active' | 'debug' | 'pinned';

export type ChangedField = {
  path: string;
  from: JsonValue;
  to: JsonValue;
};

export type AttemptLease = {
  generation: number;
  workerId: string;
  tokenDigest: string;
  acquiredAt: string;
  expiresAt: string;
};

export type FailureSource =
  | 'provider'
  | 'network'
  | 'worker'
  | 'lease'
  | 'tool'
  | 'validator'
  | 'environment'
  | 'state'
  | 'effect'
  | 'policy';

export type FailureDescriptor = {
  schemaVersion: 1;
  stage: string;
  code: string;
  source: FailureSource;
  retryClass: 'retryable' | 'repairable' | 'terminal';
  sideEffectState: 'none' | 'idempotent-confirmed' | 'unknown';
  paths: string[];
  validatorPath: string | null;
  inputDigest: string;
  environmentDigest: string;
  observedAt: string;
  retryAfterMs: number | null;
  fingerprint: string;
};

export type RepairValidationError = {
  path: string;
  code: string;
  message: string;
};

export type RepairContext = {
  previousOutputDigest: string;
  validationErrors: RepairValidationError[];
  targetSchemaDigest: string;
  instruction: 'return-complete-replacement-object';
  epoch: number;
  contextDigest: string;
};

export type AttemptRecord = {
  schemaVersion: 2;
  attemptId: string;
  jobId: string;
  workflowId: string;
  epoch: number;
  attemptNumber: number;
  retryOf: string | null;
  provider: string;
  status: AttemptStatus;
  inputDigest: string;
  requestDigest: string;
  contextDigest: string;
  environmentDigest: string;
  retryMode: RetryMode;
  policySnapshot: ExecutionPolicySnapshot;
  changedFields: ChangedField[];
  repairContext: RepairContext | null;
  strategyChanges: string[];
  grantId: string | null;
  failure: FailureDescriptor | null;
  failureFingerprint: string | null;
  leaseGeneration: number;
  lease: AttemptLease | null;
  runtimeMs: number;
  providerCostMicros: number;
  providerTokens: number;
  retention: AttemptRetention;
  providerInvocation: {
    invocationId: string;
    invocationAttempt: number;
    invocationRevision: number;
  } | null;
  createdAt: string;
  updatedAt: string;
};

/** Compatibility name for the public core-owned acceptance binding DTO. */
export type AttemptResult = AttemptAcceptanceBindingV1;

export type RetryDecision = {
  retryable: boolean;
  automatic: boolean;
  retryMode: RetryMode;
  retryAfterMs?: number;
  requiredGrant?: GrantRequest;
  changedStrategyRequired?: boolean;
  reasonCode: string;
};

/** Compatibility name for the public core-owned probe vocabulary. */
export type ReadOnlyProbeKind = ReadOnlyProbeKindV1;

/** Compatibility name for the public core-owned probe request. */
export type ReadOnlyProbeRequest = ReadOnlyProbeRequestV1;

export type ProviderInvocationProjection = {
  workflow: WorkflowRecord;
  job: JobRecord;
  attempt: AttemptRecord;
};

export type ExecutionFailureKind =
  | 'provider-timeout'
  | 'network'
  | 'rate-limit'
  | 'provider-process-crash'
  | 'worker-crash'
  | 'lease-expiry'
  | 'temporary-file-lock'
  | 'provider-capacity'
  | 'stdout-truncated'
  | 'process-nonzero'
  | 'json-parse'
  | 'schema-mismatch'
  | 'missing-required-field'
  | 'citation-out-of-range'
  | 'probe-transient'
  | 'needs-user-decision'
  | 'state-corruption'
  | 'unknown-side-effect';

export type ExecutionFailureStateProjection = Readonly<{
  workflow: WorkflowRecord;
  job: JobRecord;
}>;
