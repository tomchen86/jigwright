/** Reads repository task authority and admits scopes under its canonical policy. */
import path from 'node:path';
import fs from 'node:fs';
import type { WorkflowConfig } from '../../../../modules/repository-consumer/workflow-config.ts';
import type { TaskAuthorizationRequirement } from '../../../../modules/repository-consumer/task-authorization-policy.ts';
import {
  digestPolicy,
  resolveTaskAuthorizationRequirementForPolicy,
} from '../../../../modules/repository-consumer/task-authorization-policy.ts';
import {
  workflowError,
  ExitCode,
} from '../../../../foundation/errors/errors.ts';
import {
  type PathRoleRegistry,
  parsePathRoleRegistry,
} from '../../../../modules/source/path-role-registry.ts';
import { normalizePolicyPath } from '../../../../foundation/repository-path/repository-path.ts';

export function resolveTaskAuthorizationRequirement(
  repositoryRoot: string,
  config: Pick<WorkflowConfig, 'taskAuthorization'>,
  allowedPaths: readonly string[],
): TaskAuthorizationRequirement {
  if (config.taskAuthorization === undefined) {
    return Object.freeze({
      requiresMandate: true,
      mode: 'legacy-unconditional' as const,
      roles: Object.freeze([]),
      matchedPatterns: Object.freeze([]),
      unclassifiedScope: true,
      policyDigest: digestPolicy({ mode: 'legacy-unconditional' }),
    });
  }
  const registry = readPathRoleRegistry(
    repositoryRoot,
    config.taskAuthorization.pathRoleRegistry,
  );
  return resolveTaskAuthorizationRequirementForPolicy(
    config.taskAuthorization,
    registry,
    allowedPaths,
  );
}

export function assertTaskMandateOptional(
  repositoryRoot: string,
  config: Pick<WorkflowConfig, 'taskAuthorization'>,
  allowedPaths: readonly string[],
): TaskAuthorizationRequirement {
  const requirement = resolveTaskAuthorizationRequirement(
    repositoryRoot,
    config,
    allowedPaths,
  );
  if (requirement.requiresMandate) {
    throw workflowError(
      'TASK_MANDATE_REQUIRED',
      'This task scope intersects protected repository paths and requires a human-signed Task Mandate.',
      ExitCode.guard,
      {
        details: {
          mode: requirement.mode,
          roles: requirement.roles,
          matchedPatterns: requirement.matchedPatterns,
          unclassifiedScope: requirement.unclassifiedScope,
        },
        recovery:
          'Authorize the change scope, then retry with --mandate <mandate-task-id>.',
      },
    );
  }
  return requirement;
}

function readPathRoleRegistry(
  repositoryRoot: string,
  registryPath: string,
): PathRoleRegistry {
  const absolute = path.join(repositoryRoot, normalizePolicyPath(registryPath));
  try {
    return parsePathRoleRegistry(JSON.parse(fs.readFileSync(absolute, 'utf8')));
  } catch (error) {
    throw workflowError(
      'TASK_AUTHORIZATION_POLICY_INVALID',
      'The configured task path-role registry is missing or malformed.',
      ExitCode.guard,
      {
        details: {
          registryPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}
