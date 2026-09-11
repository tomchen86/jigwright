/**
 * Validates execution records and constructs canonical failure descriptors.
 *
 * Invariants:
 * - Retry delay must be a nonnegative safe integer no greater than one day.
 */
import { ExitCode } from "../../foundation/errors/errors.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { assertExecutionWorkflowRecordV2, ExecutionWorkflowRecordCodecError, } from '@jigwright/core/execution-workflow-record';
import { assertAttemptAcceptanceBindingV1, AttemptResultCodecError, assertSemanticJobSpecV1, SemanticJobSpecCodecError, } from '@jigwright/core/job-attempt-runtime';
import { assertExecutionPolicySnapshotV1, ExecutionPolicySnapshotCodecError, } from '@jigwright/core/execution-policy-snapshot';
import { assertExecutionRetryPolicyV1, ExecutionRetryPolicyCodecError, } from '@jigwright/core/execution-retry-policy';
import { assertIdentifier, assertErrorCode, FAILURE_SOURCES, executionInvalid, normalizeFailurePaths, assertJsonPointer, assertDigest, assertTimestamp, digestCanonical, deepFreeze, executionError, parseCanonicalRecord, isPlainObject, hasKeysEither, JOB_STATUSES, assertPositiveInteger, assertExecutionJobMandateBinding, assertNonnegativeInteger, hasExactKeys, ATTEMPT_STATUSES, RETRY_MODES, ATTEMPT_RETENTION, normalizeUniqueStrings, assertBoundedString, } from "./execution-values.js";
export function createFailureDescriptor(input) {
    const stage = assertIdentifier(input.stage, 'stage');
    const code = assertErrorCode(input.code);
    if (!FAILURE_SOURCES.has(input.source)) {
        throw executionInvalid('Failure source is unknown.');
    }
    if (!['retryable', 'repairable', 'terminal'].includes(input.retryClass)) {
        throw executionInvalid('Failure retryClass is unknown.');
    }
    if (!['none', 'idempotent-confirmed', 'unknown'].includes(input.sideEffectState)) {
        throw executionInvalid('Failure sideEffectState is unknown.');
    }
    const paths = normalizeFailurePaths(input.paths);
    const validatorPath = input.validatorPath === null
        ? null
        : assertJsonPointer(input.validatorPath, 'validatorPath');
    const inputDigest = assertDigest(input.inputDigest);
    const environmentDigest = assertDigest(input.environmentDigest);
    const observedAt = assertTimestamp(input.observedAt);
    const retryAfterMs = input.retryAfterMs ?? null;
    if (retryAfterMs !== null &&
        (!Number.isSafeInteger(retryAfterMs) ||
            retryAfterMs < 0 ||
            retryAfterMs > 86_400_000)) {
        throw executionInvalid('retryAfterMs is invalid.');
    }
    const fingerprint = digestCanonical({
        stage,
        errorCode: code,
        validatorPath,
        inputDigest,
        environmentDigest,
    });
    return deepFreeze({
        schemaVersion: 1,
        stage,
        code,
        source: input.source,
        retryClass: input.retryClass,
        sideEffectState: input.sideEffectState,
        paths,
        validatorPath,
        inputDigest,
        environmentDigest,
        observedAt,
        retryAfterMs,
        fingerprint,
    });
}
const FAILURE_CLASSIFICATIONS = Object.freeze({
    'provider-timeout': {
        code: 'PROVIDER_TIMEOUT',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    network: {
        code: 'NETWORK_TRANSIENT',
        source: 'network',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'rate-limit': {
        code: 'PROVIDER_RATE_LIMIT',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'provider-process-crash': {
        code: 'PROVIDER_PROCESS_CRASH',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'worker-crash': {
        code: 'WORKER_CRASH',
        source: 'worker',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'lease-expiry': {
        code: 'LEASE_EXPIRED',
        source: 'lease',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'temporary-file-lock': {
        code: 'TEMPORARY_FILE_LOCK',
        source: 'tool',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'provider-capacity': {
        code: 'PROVIDER_CAPACITY',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'stdout-truncated': {
        code: 'PROVIDER_STDOUT_TRUNCATED',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'process-nonzero': {
        code: 'PROVIDER_PROCESS_NONZERO',
        source: 'provider',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'json-parse': {
        code: 'OUTPUT_JSON_PARSE_FAILED',
        source: 'validator',
        retryClass: 'repairable',
        sideEffectState: 'none',
    },
    'schema-mismatch': {
        code: 'OUTPUT_SCHEMA_MISMATCH',
        source: 'validator',
        retryClass: 'repairable',
        sideEffectState: 'none',
    },
    'missing-required-field': {
        code: 'OUTPUT_REQUIRED_FIELD_MISSING',
        source: 'validator',
        retryClass: 'repairable',
        sideEffectState: 'none',
    },
    'citation-out-of-range': {
        code: 'OUTPUT_CITATION_OUT_OF_RANGE',
        source: 'validator',
        retryClass: 'repairable',
        sideEffectState: 'none',
    },
    'probe-transient': {
        code: 'ENVIRONMENT_PROBE_TRANSIENT',
        source: 'environment',
        retryClass: 'retryable',
        sideEffectState: 'none',
    },
    'needs-user-decision': {
        code: 'NEEDS_USER_DECISION',
        source: 'policy',
        retryClass: 'terminal',
        sideEffectState: 'none',
    },
    'state-corruption': {
        code: 'STATE_CORRUPTION',
        source: 'state',
        retryClass: 'terminal',
        sideEffectState: 'none',
    },
    'unknown-side-effect': {
        code: 'UNKNOWN_SIDE_EFFECT_STATE',
        source: 'effect',
        retryClass: 'terminal',
        sideEffectState: 'unknown',
    },
});
export function classifyExecutionFailure(input) {
    const classification = FAILURE_CLASSIFICATIONS[input.kind];
    if (classification === undefined) {
        throw executionError('EXECUTION_FAILURE_KIND_UNKNOWN', 'The execution failure kind is not registered.', ExitCode.usage);
    }
    return createFailureDescriptor({
        ...classification,
        stage: input.stage,
        paths: input.paths ?? [],
        validatorPath: input.validatorPath ?? null,
        inputDigest: input.inputDigest,
        environmentDigest: input.environmentDigest,
        observedAt: input.observedAt,
        retryAfterMs: input.retryAfterMs,
    });
}
export function canonicalAttemptResult(result) {
    return `${canonicalJson(assertAttemptResult(result))}\n`;
}
export function parseAttemptResult(raw) {
    return parseCanonicalRecord(raw, assertAttemptResult);
}
export function assertWorkflowRecord(value) {
    try {
        return assertExecutionWorkflowRecordV2(value);
    }
    catch (error) {
        if (!(error instanceof ExecutionWorkflowRecordCodecError))
            throw error;
        throw executionInvalid(error.message);
    }
}
export function assertJobRecord(value) {
    const baseKeys = [
        'acceptedAttemptId',
        'attemptCount',
        'contextDigest',
        'createdAt',
        'cumulativeRuntimeMs',
        'epoch',
        'jobId',
        'providerCostMicros',
        'providerTokens',
        'repairAttemptCount',
        'requestDigest',
        'retryPolicy',
        'schemaVersion',
        'semanticSpec',
        'stage',
        'status',
        'updatedAt',
        'workflowId',
    ];
    if (!isPlainObject(value) ||
        !hasKeysEither(value, [baseKeys, [...baseKeys, 'mandateBinding']]) ||
        value.schemaVersion !== 2 ||
        !JOB_STATUSES.has(value.status)) {
        throw executionInvalid('Job record is invalid.');
    }
    assertIdentifier(value.jobId, 'jobId');
    assertIdentifier(value.workflowId, 'workflowId');
    assertPositiveInteger(value.epoch, 'epoch');
    if (Object.prototype.hasOwnProperty.call(value, 'mandateBinding')) {
        assertExecutionJobMandateBinding(value.mandateBinding);
    }
    assertIdentifier(value.stage, 'stage');
    assertDigest(value.contextDigest);
    assertDigest(value.requestDigest);
    const semanticSpec = assertSemanticJobSpec(value.semanticSpec);
    if (semanticSpec.stage !== value.stage ||
        semanticSpec.contextDigest !== value.contextDigest) {
        throw executionInvalid('Job semantic specification binding is invalid.');
    }
    if (value.acceptedAttemptId !== null) {
        assertIdentifier(value.acceptedAttemptId, 'acceptedAttemptId');
    }
    const attemptCount = assertNonnegativeInteger(value.attemptCount, 'attemptCount');
    if (attemptCount < 1) {
        throw executionInvalid('attemptCount must be positive.');
    }
    assertNonnegativeInteger(value.cumulativeRuntimeMs, 'cumulativeRuntimeMs');
    assertNonnegativeInteger(value.providerCostMicros, 'providerCostMicros');
    assertNonnegativeInteger(value.providerTokens, 'providerTokens');
    assertNonnegativeInteger(value.repairAttemptCount, 'repairAttemptCount');
    assertRetryPolicy(value.retryPolicy);
    assertTimestamp(value.createdAt);
    assertTimestamp(value.updatedAt);
    if (Date.parse(value.updatedAt) <
        Date.parse(value.createdAt)) {
        throw executionInvalid('Job timestamps are not monotonic.');
    }
    if ((value.status === 'succeeded') !== (value.acceptedAttemptId !== null)) {
        throw executionInvalid('Job accepted result and succeeded state disagree.');
    }
    return deepFreeze(structuredClone(value));
}
export function requireExecutionJobMandateBinding(input) {
    const job = assertJobRecord(input);
    if (job.mandateBinding === undefined) {
        throw executionError('EXECUTION_JOB_MANDATE_REQUIRED', 'An Execution Job without a durable Task Mandate binding is read-only.', ExitCode.guard);
    }
    return assertExecutionJobMandateBinding(job.mandateBinding);
}
export function assertAttemptRecord(value) {
    if (!isPlainObject(value) ||
        !hasExactKeys(value, [
            'attemptId',
            'attemptNumber',
            'changedFields',
            'contextDigest',
            'createdAt',
            'environmentDigest',
            'epoch',
            'failure',
            'failureFingerprint',
            'grantId',
            'inputDigest',
            'jobId',
            'lease',
            'leaseGeneration',
            'providerInvocation',
            'policySnapshot',
            'provider',
            'providerCostMicros',
            'providerTokens',
            'repairContext',
            'requestDigest',
            'retention',
            'retryMode',
            'retryOf',
            'runtimeMs',
            'schemaVersion',
            'status',
            'strategyChanges',
            'updatedAt',
            'workflowId',
        ]) ||
        value.schemaVersion !== 2 ||
        !ATTEMPT_STATUSES.has(value.status) ||
        !RETRY_MODES.has(value.retryMode) ||
        !ATTEMPT_RETENTION.has(value.retention)) {
        throw executionInvalid('Attempt record is invalid.');
    }
    assertIdentifier(value.attemptId, 'attemptId');
    assertIdentifier(value.jobId, 'jobId');
    assertIdentifier(value.workflowId, 'workflowId');
    assertPositiveInteger(value.epoch, 'epoch');
    assertPositiveInteger(value.attemptNumber, 'attemptNumber');
    if (value.retryOf !== null)
        assertIdentifier(value.retryOf, 'retryOf');
    assertIdentifier(value.provider, 'provider');
    assertDigest(value.inputDigest);
    assertDigest(value.requestDigest);
    assertDigest(value.contextDigest);
    assertDigest(value.environmentDigest);
    assertExecutionPolicy(value.policySnapshot);
    assertChangedFields(value.changedFields);
    if (value.repairContext !== null) {
        assertRepairContextShape(value.repairContext);
    }
    normalizeUniqueStrings(value.strategyChanges, 'strategyChanges', true);
    if (value.grantId !== null)
        assertIdentifier(value.grantId, 'grantId');
    if (value.failure !== null) {
        const failure = assertFailureDescriptor(value.failure);
        if (value.failureFingerprint !== failure.fingerprint) {
            throw executionInvalid('Attempt failure fingerprint is inconsistent.');
        }
    }
    else if (value.failureFingerprint !== null) {
        throw executionInvalid('Attempt failure fingerprint has no descriptor.');
    }
    if ((['failed-retryable', 'failed-terminal', 'timed-out'].includes(value.status) &&
        value.failure === null) ||
        (['created', 'leased', 'running', 'succeeded'].includes(value.status) &&
            value.failure !== null)) {
        throw executionInvalid('Attempt terminal failure state and FailureDescriptor disagree.');
    }
    assertNonnegativeInteger(value.leaseGeneration, 'leaseGeneration');
    assertAttemptLease(value.lease, value.leaseGeneration);
    assertNonnegativeInteger(value.runtimeMs, 'runtimeMs');
    assertNonnegativeInteger(value.providerCostMicros, 'providerCostMicros');
    assertNonnegativeInteger(value.providerTokens, 'providerTokens');
    assertProviderInvocationProjection(value.providerInvocation);
    assertTimestamp(value.createdAt);
    assertTimestamp(value.updatedAt);
    if (Date.parse(value.updatedAt) <
        Date.parse(value.createdAt)) {
        throw executionInvalid('Attempt timestamps are not monotonic.');
    }
    return deepFreeze(structuredClone(value));
}
export function assertAttemptResult(value) {
    try {
        return assertAttemptAcceptanceBindingV1(value);
    }
    catch (error) {
        if (!(error instanceof AttemptResultCodecError))
            throw error;
        throw executionInvalid('Attempt result is invalid.');
    }
}
export function assertSemanticJobSpec(value) {
    try {
        return assertSemanticJobSpecV1(value);
    }
    catch (error) {
        if (!(error instanceof SemanticJobSpecCodecError))
            throw error;
        throw executionInvalid(error.message);
    }
}
export function assertExecutionPolicy(value) {
    try {
        return assertExecutionPolicySnapshotV1(value);
    }
    catch (error) {
        if (error instanceof ExecutionPolicySnapshotCodecError) {
            if (error.code === 'EXECUTION_POLICY_SNAPSHOT_CANONICAL_JSON_INVALID') {
                throw executionError('CANONICAL_JSON_INVALID', error.message, ExitCode.usage);
            }
            throw executionInvalid(error.message);
        }
        throw error;
    }
}
export function assertRetryPolicy(value) {
    try {
        return assertExecutionRetryPolicyV1(value);
    }
    catch (error) {
        if (!(error instanceof ExecutionRetryPolicyCodecError))
            throw error;
        throw executionInvalid(error.message);
    }
}
export function assertFailureDescriptor(value) {
    if (!isPlainObject(value) ||
        !hasExactKeys(value, [
            'code',
            'environmentDigest',
            'fingerprint',
            'inputDigest',
            'observedAt',
            'paths',
            'retryAfterMs',
            'retryClass',
            'schemaVersion',
            'sideEffectState',
            'source',
            'stage',
            'validatorPath',
        ]) ||
        value.schemaVersion !== 1) {
        throw executionInvalid('Failure descriptor is invalid.');
    }
    const rebuilt = createFailureDescriptor({
        stage: value.stage,
        code: value.code,
        source: value.source,
        retryClass: value.retryClass,
        sideEffectState: value.sideEffectState,
        paths: value.paths,
        validatorPath: value.validatorPath,
        inputDigest: value.inputDigest,
        environmentDigest: value.environmentDigest,
        observedAt: value.observedAt,
        retryAfterMs: value.retryAfterMs === null ? undefined : value.retryAfterMs,
    });
    if (rebuilt.fingerprint !== value.fingerprint ||
        canonicalJson(rebuilt) !== canonicalJson(value)) {
        throw executionInvalid('Failure descriptor is not canonical.');
    }
    return rebuilt;
}
export function assertRepairContext(value, job) {
    const context = assertRepairContextShape(value);
    if (context.epoch !== job.epoch ||
        context.contextDigest !== job.contextDigest) {
        throw executionError('RETRY_REPAIR_CONTEXT_STALE', 'Repair context is not bound to the current Job epoch.', ExitCode.staleState);
    }
    return context;
}
function assertRepairContextShape(value) {
    if (!isPlainObject(value) ||
        !hasExactKeys(value, [
            'contextDigest',
            'epoch',
            'instruction',
            'previousOutputDigest',
            'targetSchemaDigest',
            'validationErrors',
        ]) ||
        value.instruction !== 'return-complete-replacement-object' ||
        !Array.isArray(value.validationErrors)) {
        throw executionInvalid('Repair context is invalid.');
    }
    assertDigest(value.previousOutputDigest);
    assertDigest(value.targetSchemaDigest);
    assertPositiveInteger(value.epoch, 'repair epoch');
    assertDigest(value.contextDigest);
    let previousKey = '';
    for (const error of value.validationErrors) {
        if (!isPlainObject(error) ||
            !hasExactKeys(error, ['code', 'message', 'path'])) {
            throw executionInvalid('Repair validation error is invalid.');
        }
        const pointer = assertJsonPointer(error.path, 'repair error path');
        const code = assertErrorCode(error.code);
        assertBoundedString(error.message, 'repair error message');
        const key = `${pointer}\u0000${code}`;
        if (key <= previousKey) {
            throw executionInvalid('Repair validation errors are not sorted and unique.');
        }
        previousKey = key;
    }
    return deepFreeze(structuredClone(value));
}
function assertChangedFields(value) {
    if (!Array.isArray(value))
        throw executionInvalid('changedFields is invalid.');
    let previous = '';
    for (const entry of value) {
        if (!isPlainObject(entry) || !hasExactKeys(entry, ['from', 'path', 'to'])) {
            throw executionInvalid('changedFields entry is invalid.');
        }
        const pointer = assertJsonPointer(entry.path, 'changedFields path');
        canonicalJson(entry.from);
        canonicalJson(entry.to);
        if (pointer <= previous ||
            canonicalJson(entry.from) === canonicalJson(entry.to)) {
            throw executionInvalid('changedFields is not canonical.');
        }
        previous = pointer;
    }
}
function assertAttemptLease(value, generation) {
    if (value === null)
        return;
    if (!isPlainObject(value) ||
        !hasExactKeys(value, [
            'acquiredAt',
            'expiresAt',
            'generation',
            'tokenDigest',
            'workerId',
        ]) ||
        value.generation !== generation) {
        throw executionInvalid('Attempt lease is invalid.');
    }
    assertPositiveInteger(value.generation, 'lease generation');
    assertIdentifier(value.workerId, 'lease workerId');
    assertDigest(value.tokenDigest);
    assertTimestamp(value.acquiredAt);
    assertTimestamp(value.expiresAt);
    if (Date.parse(value.expiresAt) <=
        Date.parse(value.acquiredAt)) {
        throw executionInvalid('Attempt lease expiry is invalid.');
    }
}
function assertProviderInvocationProjection(value) {
    if (value === null)
        return;
    if (!isPlainObject(value) ||
        !hasExactKeys(value, [
            'invocationId',
            'invocationAttempt',
            'invocationRevision',
        ])) {
        throw executionInvalid('Provider invocation projection is invalid.');
    }
    assertIdentifier(value.invocationId, 'provider invocationId');
    assertPositiveInteger(value.invocationAttempt, 'provider invocation attempt');
    assertNonnegativeInteger(value.invocationRevision, 'provider invocation revision');
}
