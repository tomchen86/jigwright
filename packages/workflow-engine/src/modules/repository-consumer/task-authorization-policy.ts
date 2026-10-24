/** Pure task authorization policy parsing and scope classification. */
import crypto from 'node:crypto';
import {
  type PathRole,
  type PathRoleRegistry,
  resolvePathRole,
  PATH_ROLES,
} from '../source/path-role-registry.ts';
import type { TaskAuthorizationPolicy } from './workflow-config.ts';
import {
  normalizePolicyPath,
  matchesAllowedPath,
} from '../../foundation/repository-path/repository-path.ts';
import {
  isRecord,
  isStringArray,
} from '../../foundation/canonical-json/contract-values.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

export type TaskAuthorizationRequirement = Readonly<{
  requiresMandate: boolean;
  mode: 'conditional' | 'legacy-unconditional';
  roles: readonly PathRole[];
  matchedPatterns: readonly string[];
  unclassifiedScope: boolean;
  policyDigest: string;
}>;

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

export function digestPolicy(value: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}
