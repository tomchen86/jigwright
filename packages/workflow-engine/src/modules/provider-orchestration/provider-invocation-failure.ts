/** Classifies caught provider errors into durable failure and retry evidence. */
import { assertReadOnlyProbeRequestV1 } from '@jigwright/core/read-only-probe';
import {
  WorkflowError,
  durableFailureMessage,
} from '../../foundation/errors/errors.ts';
import type { ProviderInvocationFailure } from './provider-invocation-record.ts';
import type {
  ExecutionFailureKind,
  ReadOnlyProbeRequest,
} from './execution-record-types.ts';

export function classifyProviderInvocationFailure(
  error: unknown,
): ProviderInvocationFailure {
  const code =
    error instanceof WorkflowError
      ? error.code
      : 'PROVIDER_WORKER_UNEXPECTED_FAILURE';
  const staleContext = new Set([
    'PROVIDER_CONTEXT_STALE_OR_WRONG',
    'PROVIDER_ACCEPTANCE_BINDING_STALE',
    'PROVIDER_REPAIR_AUTHORITY_STALE',
    'PROVIDER_INVOCATION_TERMINALLY_RESOLVED',
    'EXECUTION_CONTEXT_CAS_MISMATCH',
    'EXECUTION_CONTEXT_STALE_EPOCH',
    'EXECUTION_CONTEXT_STALE_MANIFEST',
  ]).has(code);
  const probe = providerFailureProbe(error);
  const executionKind = providerExecutionFailureKind(
    code,
    staleContext,
    probe !== null,
  );
  const retryAfterMs = providerRetryAfterMs(error);
  return {
    kind: staleContext
      ? ('repository-reconciliation-required' as const)
      : ('retryable' as const),
    code,
    message: durableFailureMessage(
      `Provider invocation failed durably (${code})`,
      error,
    ),
    ...(executionKind === null ? {} : { executionKind }),
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
    ...(executionKind === 'probe-transient' && probe !== null ? { probe } : {}),
  };
}

function providerExecutionFailureKind(
  code: string,
  staleContext: boolean,
  hasExactProbe: boolean,
): ExecutionFailureKind | null {
  if (staleContext) return 'unknown-side-effect';
  if (code === 'ENVIRONMENT_PROBE_TRANSIENT' && !hasExactProbe) return null;
  const exact = new Map<string, ExecutionFailureKind>([
    ['PROVIDER_TIMEOUT', 'provider-timeout'],
    ['NETWORK_TRANSIENT', 'network'],
    ['PROVIDER_RATE_LIMIT', 'rate-limit'],
    ['PROVIDER_PROCESS_CRASH', 'provider-process-crash'],
    ['PROVIDER_UNAVAILABLE', 'provider-capacity'],
    ['PROVIDER_CAPACITY', 'provider-capacity'],
    ['PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'stdout-truncated'],
    ['PROVIDER_PROCESS_NONZERO', 'process-nonzero'],
    ['PROVIDER_NATIVE_OUTPUT_INVALID', 'schema-mismatch'],
    ['OUTPUT_JSON_PARSE_FAILED', 'json-parse'],
    ['OUTPUT_SCHEMA_MISMATCH', 'schema-mismatch'],
    ['OUTPUT_REQUIRED_FIELD_MISSING', 'missing-required-field'],
    ['OUTPUT_CITATION_OUT_OF_RANGE', 'citation-out-of-range'],
    ['ENVIRONMENT_PROBE_TRANSIENT', 'probe-transient'],
    ['NEEDS_USER_DECISION', 'needs-user-decision'],
    ['STATE_CORRUPTION', 'state-corruption'],
    ['PROVIDER_WORKER_UNEXPECTED_FAILURE', 'worker-crash'],
  ]);
  return exact.get(code) ?? null;
}

function providerFailureProbe(
  error: unknown,
): Readonly<ReadOnlyProbeRequest> | null {
  if (!(error instanceof WorkflowError) || error.details?.probe === undefined) {
    return null;
  }
  try {
    return assertReadOnlyProbeRequestV1(error.details.probe);
  } catch {
    return null;
  }
}

function providerRetryAfterMs(error: unknown): number | null {
  const value =
    error instanceof WorkflowError ? error.details?.retryAfterMs : null;
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 86_400_000
    ? (value as number)
    : null;
}
