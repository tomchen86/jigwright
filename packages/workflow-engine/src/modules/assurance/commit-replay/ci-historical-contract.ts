/** Canonical commit replay contracts and pure predicates. */
import { parseCheckCommand } from '../../source/check-command.ts';
import type { CheckDefinition } from '@jigwright/core/check-command';
import type { ParsedTask } from '../../planning-provider/planning-artifact-types.ts';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { WorkflowError } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';
import { normalizePolicyPath } from '../../../foundation/repository-path/repository-path.ts';

export type HistoricalTaskAuthority = {
  changeId: string;
  taskId: string;
  tasksPath: string;
  tasks: ParsedTask[];
  allowedPaths: string[];
  requiredChecks: string[];
  checkDefinitions: Record<string, string>;
};

export type HistoricalTaskPolicy = {
  allowedPaths: string[];
  requiredChecks: string[];
  checkDefinitions: Record<string, string>;
};

export function canonicalCheckDefinition(definition: CheckDefinition): string {
  return JSON.stringify({
    command: definition.command,
    destructiveDatabase: definition.destructiveDatabase,
  });
}

export function parseCheckRegistry(
  value: Record<string, unknown>,
): Record<string, CheckDefinition> {
  return Object.fromEntries(
    Object.entries(value).map(([checkId, definition]) => {
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId) ||
        !isRecord(definition) ||
        !hasExactKeys(definition, ['command', 'destructiveDatabase']) ||
        !isStringArray(definition.command) ||
        !parseCheckCommand(definition.command) ||
        typeof definition.destructiveDatabase !== 'boolean'
      ) {
        throw ciContractError(
          'CI_PARENT_CHECKS_INVALID',
          `The parent check definition is invalid: ${checkId}.`,
        );
      }
      return [
        checkId,
        {
          command: definition.command,
          destructiveDatabase: definition.destructiveDatabase,
        },
      ];
    }),
  );
}

export function parseTaskPolicy(
  value: unknown,
  registry: Record<string, CheckDefinition>,
): HistoricalTaskPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['allowedPaths', 'requiredChecks']) ||
    !isStringArray(value.allowedPaths) ||
    value.allowedPaths.length === 0 ||
    !isStringArray(value.requiredChecks) ||
    value.requiredChecks.length === 0
  ) {
    throw ciContractError(
      'CI_PARENT_GUARD_INVALID',
      'A parent task policy is invalid.',
    );
  }
  const allowedPaths = value.allowedPaths.map(normalizePolicyPath);
  const requiredChecks = value.requiredChecks.map((checkId) => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId)) {
      throw ciContractError(
        'CI_PARENT_GUARD_INVALID',
        'A parent task policy contains an invalid check ID.',
      );
    }
    return checkId;
  });
  if (
    new Set(allowedPaths).size !== allowedPaths.length ||
    new Set(requiredChecks).size !== requiredChecks.length
  ) {
    throw ciContractError(
      'CI_PARENT_GUARD_INVALID',
      'A parent task policy contains duplicate authority.',
    );
  }
  const checkDefinitions = Object.fromEntries(
    requiredChecks.map((checkId) => {
      const definition = registry[checkId];
      if (!definition) {
        throw ciContractError(
          'CI_PARENT_CHECKS_INVALID',
          `The parent check definition is missing: ${checkId}.`,
        );
      }
      return [checkId, canonicalCheckDefinition(definition)];
    }),
  );
  return { allowedPaths, requiredChecks, checkDefinitions };
}

export function parseJson(content: string, code: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw ciContractError(code, 'A historical workflow contract is invalid.');
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function ciContractError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

export function currentPlanRequiredError(): WorkflowError {
  return ciContractError(
    'CI_TASK_CURRENT_PLAN_REQUIRED',
    'Task authority requires an immutable current-v3 governing plan commit.',
  );
}

export type CiHistoricalReplayOperations = {
  loadHistoricalTaskAuthority(
    repositoryRoot: string,
    commit: string,
    requestedChangeId: string,
    requestedTaskId: string,
    changeRoot?: string,
  ): HistoricalTaskAuthority;
};
