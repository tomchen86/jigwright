/**
 * Validates change identifiers and repository paths with stable workflow errors.
 *
 * Invariants:
 * - Core validation remains authoritative for accepted identifiers and path syntax.
 * - Error codes, messages, details, and recovery hints preserve their exact values.
 */
import {
  assertChangeId as assertCoreChangeId,
  assertTaskId as assertCoreTaskId,
  assertSessionId as assertCoreSessionId,
  assertInvestigationId as assertCoreInvestigationId,
  assertInvocationId as assertCoreInvocationId,
} from '@jigwright/core/workflow-identifiers';
import {
  RepositoryPathError,
  matchesAllowedPath as matchesCoreAllowedPath,
  normalizeChangedPath as normalizeCoreChangedPath,
  normalizeExactRepositoryPath as normalizeCoreExactRepositoryPath,
  normalizePolicyPath as normalizeCorePolicyPath,
} from '@jigwright/core/repository-path';

import { ExitCode, workflowError } from '../errors/errors.ts';

export function assertChangeId(value: string): string {
  return assertCoreChangeId(value, () =>
    workflowError(
      'INVALID_CHANGE_ID',
      `Invalid change ID: ${value}`,
      ExitCode.usage,
      {
        recovery: 'Use lower-case kebab-case, for example add-expense-export.',
      },
    ),
  );
}

export function normalizePolicyPath(value: string): string {
  return withWorkflowPathErrors(() => normalizeCorePolicyPath(value));
}

export function normalizeChangedPath(value: string): string {
  return withWorkflowPathErrors(() => normalizeCoreChangedPath(value));
}

export function normalizeExactRepositoryPath(value: string): string {
  return withWorkflowPathErrors(() => normalizeCoreExactRepositoryPath(value));
}

export function matchesAllowedPath(
  changedPath: string,
  allowedPath: string,
): boolean {
  return withWorkflowPathErrors(() =>
    matchesCoreAllowedPath(changedPath, allowedPath),
  );
}

function withWorkflowPathErrors<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof RepositoryPathError)) throw error;
    throw error.code === 'INVALID_POLICY_PATH'
      ? invalidPolicyPath(error.value)
      : invalidRepositoryPath(error.value);
  }
}

function invalidPolicyPath(value: string): ReturnType<typeof workflowError> {
  return workflowError(
    'INVALID_POLICY_PATH',
    `Invalid policy path: ${value}`,
    ExitCode.guard,
    {
      details: { path: value },
      recovery:
        'Use a repository-relative exact path or a directory prefix ending in /**.',
    },
  );
}

function invalidRepositoryPath(
  value: string,
): ReturnType<typeof workflowError> {
  return workflowError(
    'INVALID_REPOSITORY_PATH',
    `Invalid repository path reported by Git: ${value}`,
    ExitCode.guard,
    { details: { path: value } },
  );
}

export function assertTaskId(value: string): string {
  return assertCoreTaskId(value, () =>
    workflowError(
      'INVALID_TASK_ID',
      `Invalid task ID: ${value}`,
      ExitCode.usage,
      { recovery: 'Use a dotted numeric task ID, for example 1.1.' },
    ),
  );
}

export function assertSessionId(value: string): string {
  return assertCoreSessionId(value, () =>
    workflowError(
      'INVALID_SESSION_ID',
      `Invalid session ID: ${value}`,
      ExitCode.usage,
    ),
  );
}

export function assertInvestigationId(value: string): string {
  return assertCoreInvestigationId(value, () =>
    workflowError(
      'INVALID_INVESTIGATION_ID',
      `Invalid investigation ID: ${value}`,
      ExitCode.usage,
    ),
  );
}

export function assertInvocationId(value: string): string {
  return assertCoreInvocationId(value, () =>
    workflowError(
      'INVALID_INVOCATION_ID',
      `Invalid provider invocation ID: ${value}`,
      ExitCode.usage,
    ),
  );
}
