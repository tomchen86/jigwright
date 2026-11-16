/**
 * Share runner value predicates, digest helpers, and exact failure constructors.
 *
 * Invariants:
 * - Error codes, details, repair payloads, and digest bytes remain unchanged.
 * - Shared predicates retain their original acceptance behavior.
 */

import crypto from 'node:crypto';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type { ProviderResolutionStatus } from './provider-runner.ts';
import type { ProviderValidationError } from './provider-runner-output.ts';

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

// --- Typed error constructors ---------------------------------------------

export function providerUnavailable(
  providerId: ProviderId,
  status: ProviderResolutionStatus,
): WorkflowError {
  return workflowError(
    'PROVIDER_UNAVAILABLE',
    `Provider "${providerId}" is not available: ${status}.`,
    ExitCode.unsafeEnvironment,
    { details: { status } },
  );
}

export function providerProfileStale(): WorkflowError {
  return workflowError(
    'PROVIDER_PROFILE_SNAPSHOT_STALE',
    'The selected provider profile no longer matches its code-owned definition.',
    ExitCode.staleState,
  );
}

export function requestUnbound(): WorkflowError {
  return workflowError(
    'PROVIDER_REQUEST_UNBOUND',
    'Provider invocation input is not bound to the request provider.',
    ExitCode.guard,
  );
}

export function wrapperProtocolAsyncRequired(): WorkflowError {
  return workflowError(
    'PROVIDER_WRAPPER_PROTOCOL_ASYNC_REQUIRED',
    'Provider wrapper protocol execution requires the asynchronous Agent Runtime path.',
    ExitCode.guard,
  );
}

export function wrapperProtocolInvalid(): WorkflowError {
  return workflowError(
    'PROVIDER_WRAPPER_PROTOCOL_INVALID',
    'Provider wrapper protocol evidence is missing, malformed, or does not match the bound invocation.',
    ExitCode.guard,
  );
}

export function wrapperReportedError(): WorkflowError {
  return workflowError(
    'PROVIDER_WRAPPER_REPORTED_ERROR',
    'Provider wrapper reported a terminal execution error.',
    ExitCode.verification,
  );
}

export function repositoryMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_REPOSITORY_MISMATCH',
    'Provider request repository identity does not match this repository.',
    ExitCode.guard,
  );
}

export function durableRequestMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_DURABLE_REQUEST_MISMATCH',
    'Launch request does not match the durable canonical invocation request.',
    ExitCode.staleState,
  );
}

export function inputManifestMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_INPUT_MANIFEST_MISMATCH',
    'Durable input manifest does not match the request manifest digest.',
    ExitCode.staleState,
  );
}

export function policyMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_POLICY_MISMATCH',
    'Provider request is not bound to the current adapter policy or its limits.',
    ExitCode.guard,
  );
}

export function policyBaselineMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_POLICY_BASELINE_MISMATCH',
    'Live adapter policy bytes differ from the pinned baseline commit.',
    ExitCode.staleState,
  );
}

export function configBaselineMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_CONFIG_BASELINE_MISMATCH',
    'Live workflow configuration bytes differ from the pinned baseline commit.',
    ExitCode.staleState,
  );
}

export function providerDisabled(providerId: ProviderId): WorkflowError {
  return workflowError(
    'PROVIDER_DISABLED',
    `Provider "${providerId}" is disabled by the adapter policy.`,
    ExitCode.guard,
  );
}

export function baselineMismatch(): WorkflowError {
  return workflowError(
    'PROVIDER_BASELINE_MISMATCH',
    'Provider request baseline does not match the current repository HEAD/tree.',
    ExitCode.staleState,
  );
}

export function outputSchemaUnbound(): WorkflowError {
  return workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNBOUND',
    'Provider semantic output schema does not match the request output schema digest.',
    ExitCode.guard,
  );
}

export function runtimeDirectoryUnsafe(directory: string): WorkflowError {
  return workflowError(
    'PROVIDER_RUNTIME_DIRECTORY_UNSAFE',
    'Provider runtime directory is not the configured investigation invocation directory.',
    ExitCode.unsafeEnvironment,
    { details: { directory } },
  );
}

export function runtimePathUnsafe(filePath: string): WorkflowError {
  return workflowError(
    'PROVIDER_RUNTIME_PATH_UNSAFE',
    'Provider runtime file is not an exclusively created no-follow single-link regular file.',
    ExitCode.unsafeEnvironment,
    { details: { path: filePath } },
  );
}

export function concurrencyLimitExceeded(): WorkflowError {
  return workflowError(
    'PROVIDER_CONCURRENCY_LIMIT',
    'Provider concurrency limit reached for this repository.',
    ExitCode.conflict,
  );
}

export function concurrencySlotFailed(): WorkflowError {
  return workflowError(
    'PROVIDER_CONCURRENCY_SLOT_FAILED',
    'Unable to acquire a repository-wide provider concurrency slot.',
    ExitCode.unsafeEnvironment,
  );
}

export function executableIdentityDrift(): WorkflowError {
  return workflowError(
    'PROVIDER_EXECUTABLE_IDENTITY_DRIFT',
    'Provider executable identity changed around the invocation.',
    ExitCode.unsafeEnvironment,
  );
}

export function governedProjectionDrift(
  changedCategories: string[],
): WorkflowError {
  return workflowError(
    'PROVIDER_GOVERNED_PROJECTION_DRIFT',
    'Governed projection changed during the provider invocation.',
    ExitCode.verification,
    { details: { changedCategories } },
  );
}

export function outputLimitExceeded(): WorkflowError {
  return workflowError(
    'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    'Provider aggregate output exceeded the bounded byte limit.',
    ExitCode.verification,
  );
}

type NativeOutputRepair = {
  repairKind: 'schema' | 'semantic';
  previousOutput: unknown;
  validationErrors: ProviderValidationError[];
};

export function nativeOutputRepair(
  reasonCode: string,
  message: string,
): NativeOutputRepair {
  return {
    repairKind: 'schema',
    // Native bytes may contain prompts, credentials, or other provider output
    // that is not safe to persist. Repair lineage therefore records only this
    // fixed diagnostic sentinel and never copies raw stdout/file content.
    previousOutput: {
      kind: 'provider-native-output-unavailable',
      reasonCode,
    },
    validationErrors: [{ path: '/', code: reasonCode, message }],
  };
}

export function nativeOutputInvalid(
  repair: NativeOutputRepair = nativeOutputRepair(
    'NATIVE_OUTPUT_INVALID',
    'Provider native output was malformed; return one complete object matching the target schema.',
  ),
): WorkflowError {
  return workflowError(
    'PROVIDER_NATIVE_OUTPUT_INVALID',
    'Provider native output was malformed or failed its bound output schema.',
    ExitCode.verification,
    { details: { repair } },
  );
}
