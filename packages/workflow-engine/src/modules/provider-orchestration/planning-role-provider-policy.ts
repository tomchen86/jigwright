/**
 * Decodes role policy bytes and projects the exact change-bound override identity.
 *
 * Invariants:
 * - A role override is canonical and binds the parsed central configuration.
 * - Absence is explicit; omitted or cross-change policy input is invalid.
 */

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseAgentRolePlanV2,
  type AgentRolePlanV2,
} from './agent-role-plan.ts';
import {
  parseCentralRoleProviderDefault,
  type CentralRoleProviderDefaultV1,
} from './central-role-provider-default.ts';
import { agentRolePlanV2Path } from '../source/planning-role-policy-paths.ts';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const DIGEST = /^[0-9a-f]{64}$/u;

export type CurrentPlanningRoleOverridePolicy = Readonly<{
  path: string;
  baseCentralConfigurationDigest: string;
  planDigest: string;
}>;

export function parseCurrentCentralRoleProviderDefaultPolicy(
  bytes: Uint8Array,
): CentralRoleProviderDefaultV1 {
  try {
    return parseCentralRoleProviderDefault(UTF8.decode(bytes));
  } catch {
    throw workflowError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID',
      'Central role/provider default is not canonical UTF-8 JSON.',
      ExitCode.verification,
    );
  }
}

export function parseCurrentAgentRolePlanV2(
  bytes: Uint8Array,
  changeId: string,
  central: CentralRoleProviderDefaultV1,
): AgentRolePlanV2 {
  let source: string;
  try {
    source = UTF8.decode(bytes);
  } catch {
    throw invalidOverride('Agent-role plan must be canonical UTF-8 JSON.');
  }
  return parseAgentRolePlanV2(source, changeId, central.configurationDigest);
}

export function projectCurrentPlanningRoleOverridePolicy(
  override: AgentRolePlanV2,
): CurrentPlanningRoleOverridePolicy {
  return Object.freeze({
    path: agentRolePlanV2Path(override.changeId),
    baseCentralConfigurationDigest: override.baseCentralConfigurationDigest,
    planDigest: override.planDigest,
  });
}

/** Validate the supplied identity; repository presence is established by its reader. */
export function assertCurrentPlanningRoleOverridePolicy(
  value: CurrentPlanningRoleOverridePolicy | null,
  changeId: string,
): CurrentPlanningRoleOverridePolicy | null {
  if (value === null) return null;
  if (
    value === undefined ||
    value.path !== agentRolePlanV2Path(changeId) ||
    !DIGEST.test(value.baseCentralConfigurationDigest) ||
    !DIGEST.test(value.planDigest)
  ) {
    throw invalidOverride(
      'Planning role override input must be explicit and change-bound.',
    );
  }
  return Object.freeze({ ...value });
}

function invalidOverride(message: string) {
  return workflowError(
    'AGENT_ROLE_PLAN_INVALID',
    message,
    ExitCode.verification,
  );
}
