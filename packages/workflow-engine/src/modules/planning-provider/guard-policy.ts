/** Validate guard values after repository path admission. */
import {
  isRecord,
  isStringArray,
} from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { matchesAllowedPath } from '../../foundation/repository-path/repository-path.ts';
import { engineProjectionDefinitions } from '../projection/engine-projection-registry.ts';
import type { ChecksConfig } from '../source/check-command.ts';
import { invalidContract } from './change-contract-errors.ts';
import { hasExactKeys } from './planning-artifact-parsers.ts';
import type { GuardContract, TaskPolicy } from './planning-artifact-types.ts';
const CHECK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseGuardContract(
  value: unknown,
  guardPath: string,
  expectedChangeId: string,
): GuardContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['changeId', 'schemaVersion', 'tasks']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== expectedChangeId ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length === 0
  ) {
    throw invalidContract(
      'INVALID_GUARD_CONTRACT',
      `guard.json is invalid or does not name change ${expectedChangeId}.`,
      guardPath,
    );
  }

  for (const [taskId, policy] of Object.entries(value.tasks)) {
    if (
      !isRecord(policy) ||
      !hasOneOfExactKeySets(policy, [
        ['allowedPaths', 'requiredChecks'],
        ['allowedPaths', 'exclusiveResources', 'requiredChecks'],
      ]) ||
      !isStringArray(policy.allowedPaths) ||
      policy.allowedPaths.length === 0 ||
      !isStringArray(policy.requiredChecks) ||
      policy.requiredChecks.length === 0 ||
      (policy.exclusiveResources !== undefined &&
        !isExclusiveResourceSet(policy.exclusiveResources))
    ) {
      throw invalidContract(
        'INVALID_TASK_POLICY',
        `Invalid guard policy for task ${taskId}.`,
        guardPath,
      );
    }
  }

  return value as GuardContract;
}

function isExclusiveResourceSet(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.length > 0 &&
    value.every(
      (resource) =>
        resource.length <= 160 && /^[a-z0-9][a-z0-9._:/-]*$/.test(resource),
    ) &&
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

export function validateTaskPolicy(
  taskId: string,
  policy: TaskPolicy,
  checks: ChecksConfig,
  normalizedPaths: string[],
): void {
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw workflowError(
      'DUPLICATE_ALLOWED_PATH',
      `Task ${taskId} contains duplicate allowed paths.`,
      ExitCode.guard,
    );
  }

  const claimedProjectionPaths = engineProjectionDefinitions()
    .map(({ path: projectionPath }) => projectionPath)
    .filter((projectionPath) =>
      normalizedPaths.some((allowedPath) =>
        matchesAllowedPath(projectionPath, allowedPath),
      ),
    );
  if (claimedProjectionPaths.length > 0) {
    throw workflowError(
      'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE',
      `Task ${taskId} cannot claim engine-owned projection paths.`,
      ExitCode.guard,
      { details: { taskId, claimedProjectionPaths } },
    );
  }

  const malformedChecks = policy.requiredChecks.filter(
    (checkId) => !CHECK_ID_PATTERN.test(checkId),
  );
  if (malformedChecks.length > 0) {
    throw workflowError(
      'INVALID_REQUIRED_CHECK_ID',
      `Task ${taskId} contains malformed required check IDs: ${malformedChecks.join(', ')}`,
      ExitCode.guard,
      { details: { taskId, malformedChecks } },
    );
  }

  if (new Set(policy.requiredChecks).size !== policy.requiredChecks.length) {
    throw workflowError(
      'DUPLICATE_REQUIRED_CHECK',
      `Task ${taskId} contains duplicate required checks.`,
      ExitCode.guard,
    );
  }

  const unknownChecks = policy.requiredChecks.filter(
    (checkId) => !Object.hasOwn(checks.checks, checkId),
  );
  if (unknownChecks.length > 0) {
    throw workflowError(
      'UNKNOWN_REQUIRED_CHECK',
      `Task ${taskId} references unknown checks: ${unknownChecks.join(', ')}`,
      ExitCode.guard,
      { details: { taskId, unknownChecks } },
    );
  }
}

function hasOneOfExactKeySets(
  value: Record<string, unknown>,
  expectedKeySets: readonly (readonly string[])[],
): boolean {
  return expectedKeySets.some((keys) => hasExactKeys(value, [...keys]));
}
