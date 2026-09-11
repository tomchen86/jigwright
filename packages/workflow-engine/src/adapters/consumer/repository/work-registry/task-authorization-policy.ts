/**
 * Determines whether a task scope requires a human mandate under the
 * configured path-role policy.
 *
 * Invariants:
 * - Omitting the conditional policy retains the legacy requirement for a
 *   mandate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../../../foundation/canonical-json/canonical-json.ts';
import {
  isRecord,
  isStringArray,
} from '../../../../foundation/canonical-json/contract-values.ts';
import type {
  TaskAuthorizationPolicy,
  WorkflowConfig,
} from '../../../../modules/repository-consumer/workflow-config.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  PATH_ROLES,
  parsePathRoleRegistry,
  resolvePathRole,
  type PathRole,
  type PathRoleRegistry,
} from '../../../../modules/source/path-role-registry.ts';
import {
  matchesAllowedPath,
  normalizePolicyPath,
} from '../../../../foundation/repository-path/repository-path.ts';

export type TaskAuthorizationRequirement = Readonly<{
  requiresMandate: boolean;
  mode: 'conditional' | 'legacy-unconditional';
  roles: readonly PathRole[];
  matchedPatterns: readonly string[];
  unclassifiedScope: boolean;
  policyDigest: string;
}>;

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

export function resolveTaskAuthorizationRequirementForPolicy(
  policy: TaskAuthorizationPolicy,
  registry: PathRoleRegistry,
  allowedPaths: readonly string[],
): TaskAuthorizationRequirement {
  const requiredRoles = new Set<PathRole>(policy.mandateRequiredRoles);
  const normalizedAllowed = allowedPaths.map(normalizePolicyPath);
  const intersections = normalizedAllowed.flatMap((allowed) => {
    if (!allowed.endsWith('/**')) {
      const resolution = resolvePathRole(registry, allowed);
      return resolution.registered
        ? [{ pattern: resolution.pattern, role: resolution.role }]
        : [];
    }
    return registry.rules.filter(({ pattern }) =>
      patternsIntersect(allowed, pattern),
    );
  });
  const roles = [...new Set(intersections.map(({ role }) => role))].sort();
  const matchedPatterns = [
    ...new Set(intersections.map(({ pattern }) => pattern)),
  ].sort();
  const unclassifiedScope = normalizedAllowed.some((allowed) => {
    if (!allowed.endsWith('/**')) {
      return !resolvePathRole(registry, allowed).registered;
    }
    return !registry.rules.some(({ pattern }) =>
      patternCovers(pattern, allowed),
    );
  });
  // This registry is the reviewed list of paths that require stronger human
  // authority, not an allowlist for every ordinary repository path. A path
  // without a role remains observable as unclassified, but it does not turn
  // an otherwise ordinary product change into a signing ceremony.
  const requiresMandate = roles.some((role) => requiredRoles.has(role));
  return Object.freeze({
    requiresMandate,
    mode: 'conditional' as const,
    roles: Object.freeze(roles),
    matchedPatterns: Object.freeze(matchedPatterns),
    unclassifiedScope,
    policyDigest: digestPolicy({
      policy,
      registry,
      allowedPaths: normalizedAllowed,
    }),
  });
}

export function parseTaskAuthorizationPolicyFromWorkflowConfig(
  value: unknown,
): TaskAuthorizationPolicy | null {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw taskAuthorizationInvalid(
      'Baseline workflow configuration is malformed.',
    );
  }
  if (value.taskAuthorization === undefined) return null;
  const policy = value.taskAuthorization;
  if (
    !isRecord(policy) ||
    JSON.stringify(Object.keys(policy).sort()) !==
      JSON.stringify(['mandateRequiredRoles', 'pathRoleRegistry']) ||
    policy.pathRoleRegistry !== 'workflow/path-roles.json' ||
    !isStringArray(policy.mandateRequiredRoles) ||
    policy.mandateRequiredRoles.length === 0 ||
    policy.mandateRequiredRoles.some(
      (role) => !(PATH_ROLES as readonly string[]).includes(role),
    ) ||
    new Set(policy.mandateRequiredRoles).size !==
      policy.mandateRequiredRoles.length ||
    JSON.stringify(policy.mandateRequiredRoles) !==
      JSON.stringify([...policy.mandateRequiredRoles].sort())
  ) {
    throw taskAuthorizationInvalid(
      'Baseline task authorization policy is malformed.',
    );
  }
  return Object.freeze({
    pathRoleRegistry: policy.pathRoleRegistry,
    mandateRequiredRoles: Object.freeze([
      ...(policy.mandateRequiredRoles as PathRole[]),
    ]) as unknown as PathRole[],
  });
}

function taskAuthorizationInvalid(message: string) {
  return workflowError(
    'TASK_AUTHORIZATION_POLICY_INVALID',
    message,
    ExitCode.guard,
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

function patternsIntersect(left: string, right: string): boolean {
  return patternCovers(left, right) || patternCovers(right, left);
}

function patternCovers(container: string, candidate: string): boolean {
  const normalizedContainer = normalizePolicyPath(container);
  const normalizedCandidate = normalizePolicyPath(candidate);
  if (!normalizedContainer.endsWith('/**')) {
    return normalizedContainer === normalizedCandidate;
  }
  const candidateBase = normalizedCandidate.endsWith('/**')
    ? normalizedCandidate.slice(0, -3)
    : normalizedCandidate;
  return matchesAllowedPath(candidateBase, normalizedContainer);
}

function digestPolicy(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}
