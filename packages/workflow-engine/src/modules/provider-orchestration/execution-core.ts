import type { ProviderInvocationRequest } from './provider-contracts.ts';
import { ExitCode } from '../../foundation/errors/errors.ts';
import type { ProviderInvocationRecord } from '../../runtime/storage-journal/provider-invocation-store.ts';
import {
  assertReadOnlyProbeRequestV1,
  ReadOnlyProbeCodecError,
} from '@jigwright/core/read-only-probe';
import type {
  ExecutionPolicySnapshot,
  ProviderInvocationProjection,
  ReadOnlyProbeRequest,
  RetryPolicy,
  SemanticJobSpec,
  WorkflowRecord,
  JobRecord,
  AttemptRecord,
  AttemptStatus,
  JobStatus,
  FailureDescriptor,
  FailureSource,
} from './execution-record-types.ts';
import {
  executionError,
  normalizeDigest,
  digestCanonical,
  probeNotAllowed,
  assertIdentifier,
  assertPositiveInteger,
  assertDigest,
  executionInvalid,
  assertTimestamp,
  assertExecutionJobMandateBinding,
  deepFreeze,
} from './execution-values.ts';
import {
  assertExecutionPolicy,
  assertRetryPolicy,
  assertWorkflowRecord,
  assertJobRecord,
  assertAttemptRecord,
  classifyExecutionFailure,
  createFailureDescriptor,
} from './execution-records.ts';

/**
 * Translate the provider request's process-only fields into the V2 execution
 * policy. Invocation identity, nonce, semantic target and output contract are
 * deliberately absent: changing those fields is not an execution-policy retry.
 */
export function providerExecutionPolicySnapshot(
  request: ProviderInvocationRequest,
): ExecutionPolicySnapshot {
  if (
    request.schemaVersion !== 1 ||
    request.invocationId.length === 0 ||
    request.policyDigest.length === 0
  ) {
    throw executionError(
      'PROVIDER_EXECUTION_REQUEST_INVALID',
      'Provider execution policy requires a validated provider request.',
      ExitCode.guard,
    );
  }
  return assertExecutionPolicy({
    schemaVersion: 1,
    provider: request.providerId,
    timeoutMs: request.limits.timeoutMs,
    maxOutputBytes: request.limits.aggregateOutputBytes,
    workerClass: 'provider-cli',
    backoffMs: 0,
    processEnvironment: {},
    concurrency: 1,
    transientToolConfig: {
      'policy-digest': normalizeDigest(request.policyDigest),
    },
  });
}

export function providerExecutionEnvironmentDigest(
  request: ProviderInvocationRequest,
): string {
  return digestCanonical({
    schemaVersion: 1,
    kind: 'provider-execution-environment',
    provider: request.providerId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    policyDigest: normalizeDigest(request.policyDigest),
  });
}

/** Project one current provider invocation into its durable Job and Attempt. */
export function projectProviderInvocationExecution(input: {
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
}): ProviderInvocationProjection {
  const { record, request } = input;
  if (
    request.invocationId !== record.invocationId ||
    request.requestDigest !== record.requestDigest ||
    request.providerId !== record.providerId ||
    request.purpose !== record.purpose ||
    request.inputManifestDigest !== record.manifestDigest
  ) {
    throw executionError(
      'PROVIDER_EXECUTION_BINDING_INVALID',
      'Provider invocation and request do not project to the same Attempt.',
      ExitCode.guard,
    );
  }
  const deadline = new Date(
    Date.parse(record.createdAt) + 14 * 24 * 60 * 60 * 1_000,
  ).toISOString();
  return projectProviderInvocationRecord({
    record,
    epoch: 1,
    contractVersion: 1,
    contextDigest: normalizeDigest(record.manifestDigest),
    engineBinding: digestCanonical({
      schemaVersion: 1,
      kind: 'provider-execution-core-binding',
    }),
    executionPolicy: providerExecutionPolicySnapshot(request),
    environmentDigest: providerExecutionEnvironmentDigest(request),
    semanticJobIdentityDigest: normalizeDigest(record.manifestDigest),
    retryPolicy: {
      maxAttempts: 4,
      maxCumulativeRuntimeMs: request.limits.timeoutMs * 4,
      maxProviderCostMicros: Number.MAX_SAFE_INTEGER,
      maxProviderTokens: Number.MAX_SAFE_INTEGER,
      maxSameFailureFingerprint: 2,
      maxRepairAttempts: 2,
      deadline,
      providerLimits: { [request.providerId]: 4 },
    },
  });
}

export function assertReadOnlyProbe(
  input: unknown,
): Readonly<ReadOnlyProbeRequest> {
  try {
    return assertReadOnlyProbeRequestV1(input);
  } catch (error) {
    if (error instanceof ReadOnlyProbeCodecError) {
      throw probeNotAllowed();
    }
    throw error;
  }
}

export function projectProviderInvocationRecord(input: {
  record: ProviderInvocationRecord;
  epoch: number;
  contractVersion: number;
  contextDigest: string;
  engineBinding: string;
  executionPolicy: ExecutionPolicySnapshot;
  environmentDigest: string;
  semanticJobIdentityDigest?: string;
  retryPolicy: RetryPolicy;
}): ProviderInvocationProjection {
  const record = input.record;
  if (
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1 ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !['prepared', 'leased', 'succeeded', 'failed'].includes(record.state)
  ) {
    throw executionError(
      'PROVIDER_INVOCATION_PROJECTION_INVALID',
      'The ProviderInvocationRecord cannot be projected safely.',
      ExitCode.guard,
    );
  }
  const workflowId = assertIdentifier(record.investigationId, 'workflowId');
  const epoch = assertPositiveInteger(input.epoch, 'epoch');
  const contractVersion = assertPositiveInteger(
    input.contractVersion,
    'contractVersion',
  );
  const contextDigest = assertDigest(input.contextDigest);
  const engineBinding = assertDigest(input.engineBinding);
  const executionPolicy = assertExecutionPolicy(input.executionPolicy);
  if (executionPolicy.provider !== record.providerId) {
    throw executionInvalid(
      'Provider projection policy does not match the invocation record.',
    );
  }
  const createdAt = assertTimestamp(record.createdAt);
  const updatedAt = assertTimestamp(record.updatedAt);
  const attemptId = assertIdentifier(
    `attempt-provider-${record.invocationId}`,
    'attemptId',
  );
  // Each retry receives a fresh invocationId. Binding Job identity to that ID
  // would turn an Attempt retry into a new logical Job, so the stable semantic
  // identity is the investigation/stage pair plus the exact manifest digest.
  const jobIdentityDigest = digestCanonical({
    kind: 'provider-job',
    workflowId,
    stage: record.purpose,
    ...(input.semanticJobIdentityDigest === undefined
      ? {}
      : {
          semanticJobIdentityDigest: assertDigest(
            input.semanticJobIdentityDigest,
          ),
        }),
  }).slice('sha256:'.length, 'sha256:'.length + 32);
  const jobId = assertIdentifier(
    `job-provider-${record.purpose}-${jobIdentityDigest}`,
    'jobId',
  );
  const semanticSpec: SemanticJobSpec = {
    schemaVersion: 1,
    contractVersion,
    stage: assertIdentifier(record.purpose, 'stage'),
    contextDigest,
    // The provider request includes execution details and invocation identity;
    // the manifest is the immutable semantic input shared by current retries.
    inputDigest: normalizeDigest(record.manifestDigest),
    outputContractDigest: digestCanonical({
      kind: 'provider-output-contract',
      purpose: record.purpose,
      schemaVersion: 1,
    }),
    acceptancePolicyDigest: digestCanonical({
      kind: 'provider-acceptance',
      purpose: record.purpose,
      schemaVersion: 1,
    }),
  };
  const requestDigest = digestCanonical({
    kind: 'semantic-job-spec',
    jobId,
    workflowId,
    epoch,
    ...(record.mandateBinding === undefined
      ? {}
      : {
          mandateBinding: assertExecutionJobMandateBinding(
            record.mandateBinding,
          ),
        }),
    semanticSpec,
  });
  const attemptRequestDigest = normalizeDigest(record.requestDigest);
  const status = providerAttemptStatus(record);
  const acceptedAttemptId = status === 'succeeded' ? attemptId : null;
  const jobStatus = providerJobStatus(record);
  const failure = providerFailure(
    record,
    semanticSpec.inputDigest,
    input.environmentDigest,
  );
  const lease =
    record.lease === null
      ? null
      : {
          generation: record.lease.generation,
          workerId: assertIdentifier(record.lease.workerId, 'workerId'),
          tokenDigest: normalizeDigest(record.lease.tokenDigest),
          acquiredAt: assertTimestamp(record.lease.acquiredAt),
          expiresAt: assertTimestamp(record.lease.expiresAt),
        };
  const workflow: WorkflowRecord = {
    schemaVersion: 2,
    workflowId,
    currentEpoch: epoch,
    contractVersion,
    contextDigest,
    checkpoint: record.purpose,
    status: 'active',
    blocker: null,
    engineBinding,
  };
  const job: JobRecord = {
    schemaVersion: 2,
    jobId,
    workflowId,
    epoch,
    ...(record.mandateBinding === undefined
      ? {}
      : {
          mandateBinding: assertExecutionJobMandateBinding(
            record.mandateBinding,
          ),
        }),
    stage: semanticSpec.stage,
    contextDigest,
    requestDigest,
    semanticSpec,
    status: jobStatus,
    acceptedAttemptId,
    attemptCount: record.attempt,
    cumulativeRuntimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    repairAttemptCount: 0,
    retryPolicy: assertRetryPolicy(input.retryPolicy),
    createdAt,
    updatedAt,
  };
  const attempt: AttemptRecord = {
    schemaVersion: 2,
    attemptId,
    jobId,
    workflowId,
    epoch,
    attemptNumber: record.attempt,
    retryOf: null,
    provider: executionPolicy.provider,
    status,
    inputDigest: semanticSpec.inputDigest,
    requestDigest: attemptRequestDigest,
    contextDigest,
    environmentDigest: assertDigest(input.environmentDigest),
    retryMode: record.attempt === 1 ? 'none' : 'same-input',
    policySnapshot: executionPolicy,
    changedFields: [],
    repairContext: null,
    strategyChanges: [],
    grantId: null,
    failure,
    failureFingerprint: failure?.fingerprint ?? null,
    leaseGeneration: record.leaseGeneration,
    lease,
    runtimeMs: 0,
    providerCostMicros: 0,
    providerTokens: 0,
    retention: status === 'succeeded' ? 'active' : 'debug',
    providerInvocation: {
      invocationId: assertIdentifier(record.invocationId, 'invocationId'),
      invocationAttempt: record.attempt,
      invocationRevision: record.revision,
    },
    createdAt,
    updatedAt,
  };
  return deepFreeze({
    workflow: assertWorkflowRecord(workflow),
    job: assertJobRecord(job),
    attempt: assertAttemptRecord(attempt),
  });
}

function providerAttemptStatus(
  record: ProviderInvocationRecord,
): AttemptStatus {
  if (record.state === 'prepared') return 'created';
  if (record.state === 'leased') return 'leased';
  if (record.state === 'succeeded') return 'succeeded';
  if (isProviderCancellationFailure(record)) return 'cancelled';
  if (record.failure?.code.toUpperCase().includes('TIMEOUT') === true) {
    return 'timed-out';
  }
  if (
    record.failure?.executionKind === 'needs-user-decision' ||
    record.failure?.code === 'NEEDS_USER_DECISION'
  ) {
    return 'failed-terminal';
  }
  return record.failure?.kind === 'retryable'
    ? 'failed-retryable'
    : 'failed-terminal';
}

function providerJobStatus(record: ProviderInvocationRecord): JobStatus {
  if (record.state === 'prepared') return 'queued';
  if (record.state === 'leased') return 'running';
  if (record.state === 'succeeded') return 'succeeded';
  if (isProviderCancellationFailure(record)) return 'cancelled';
  return record.failure?.kind === 'retryable'
    ? 'waiting-retry'
    : 'failed-terminal';
}

function isProviderCancellationFailure(
  record: ProviderInvocationRecord,
): boolean {
  return (
    record.failure?.code === 'PROVIDER_PROCESS_CANCELLED' ||
    record.failure?.code === 'AGENT_RUNTIME_V1_CANCELLED'
  );
}

function providerFailure(
  record: ProviderInvocationRecord,
  inputDigest: string,
  environmentDigest: string,
): FailureDescriptor | null {
  if (record.failure === null) return null;
  const code = /^[A-Z][A-Z0-9_]{1,127}$/.test(record.failure.code)
    ? record.failure.code
    : 'PROVIDER_FAILURE_UNCLASSIFIED';
  const classification =
    record.failure.executionKind === undefined
      ? classifyProviderFailure(code, record.failure.kind)
      : classifyExecutionFailure({
          kind: record.failure.executionKind,
          stage: record.purpose,
          inputDigest,
          environmentDigest,
          observedAt: record.updatedAt,
          ...(record.failure.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: record.failure.retryAfterMs }),
        });
  return createFailureDescriptor({
    stage: record.purpose,
    code,
    source: classification.source,
    retryClass: classification.retryClass,
    sideEffectState: classification.sideEffectState,
    paths: [],
    validatorPath: null,
    inputDigest,
    environmentDigest: assertDigest(environmentDigest),
    observedAt: record.updatedAt,
    retryAfterMs: record.failure.retryAfterMs,
  });
}

function classifyProviderFailure(
  code: string,
  kind: 'retryable' | 'repository-reconciliation-required',
): Pick<FailureDescriptor, 'source' | 'retryClass' | 'sideEffectState'> {
  if (kind === 'repository-reconciliation-required') {
    return {
      source: 'effect',
      retryClass: 'terminal',
      sideEffectState: 'unknown',
    };
  }
  if (code.includes('STATE_CORRUPTION')) {
    return {
      source: 'state',
      retryClass: 'terminal',
      sideEffectState: 'none',
    };
  }
  if (
    code.includes('SCHEMA') ||
    code.includes('JSON_PARSE') ||
    code.includes('REQUIRED_FIELD') ||
    code.includes('CITATION') ||
    code.includes('NATIVE_OUTPUT_INVALID')
  ) {
    return {
      source: 'validator',
      retryClass: 'repairable',
      sideEffectState: 'none',
    };
  }
  const source: FailureSource = code.includes('NETWORK')
    ? 'network'
    : code.includes('WORKER')
      ? 'worker'
      : code.includes('LEASE')
        ? 'lease'
        : code.includes('PROBE')
          ? 'environment'
          : code.includes('FILE_LOCK') || code.includes('TOOL')
            ? 'tool'
            : 'provider';
  return { source, retryClass: 'retryable', sideEffectState: 'none' };
}

export type {
  JsonPrimitive,
  JsonValue,
  WorkflowStatus,
  WorkflowBlocker,
  WorkflowRecord,
  JobStatus,
  RetryPolicy,
  SemanticJobSpec,
  ExecutionPolicySnapshot,
  JobRecord,
  RetryMode,
  AttemptStatus,
  AttemptRetention,
  ChangedField,
  AttemptLease,
  FailureSource,
  FailureDescriptor,
  RepairValidationError,
  RepairContext,
  AttemptRecord,
  AttemptResult,
  RetryDecision,
  ReadOnlyProbeKind,
  ReadOnlyProbeRequest,
  ProviderInvocationProjection,
  ExecutionFailureKind,
  ExecutionFailureStateProjection,
} from './execution-record-types.ts';
export {
  createExecutionJob,
  createReplacementAttempt,
  executionPolicyChangedFields,
  leaseAttempt,
  acceptAttemptResult,
  createAttemptResult,
} from './execution-attempts.ts';
export {
  createFailureDescriptor,
  classifyExecutionFailure,
  canonicalAttemptResult,
  parseAttemptResult,
  assertWorkflowRecord,
  assertJobRecord,
  requireExecutionJobMandateBinding,
  assertAttemptRecord,
  assertAttemptResult,
} from './execution-records.ts';
export {
  decideRetry,
  projectExecutionFailureState,
} from './execution-retry.ts';
