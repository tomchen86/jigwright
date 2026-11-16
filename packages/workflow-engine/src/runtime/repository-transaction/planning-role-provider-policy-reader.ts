/**
 * Reads stable current role plans and their central provider policy bytes.
 *
 * Invariants:
 * - A role plan and central default must remain unchanged while read as a
 *   pair.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { AgentRolePlanV2 } from '../../modules/provider-orchestration/agent-role-plan.ts';
import {
  parseCurrentCentralRoleProviderDefaultPolicy,
  parseCurrentAgentRolePlanV2,
  projectCurrentPlanningRoleOverridePolicy,
  type CurrentPlanningRoleOverridePolicy,
} from '../../modules/provider-orchestration/planning-role-provider-policy.ts';
import { agentRolePlanV2Path } from '../../modules/source/planning-role-policy-paths.ts';
import { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH } from '../../modules/provider-orchestration/central-role-provider-default.ts';

const MAX_POLICY_BYTES = 64 * 1024;

type PolicyKind = 'agent-role-plan' | 'central-role-provider-default';

type PolicyReadOptions = Readonly<{
  kind: PolicyKind;
  optional: boolean;
}>;

/** Read the exact current policy pair without granting execution authority. */
export function readCurrentPlanningAgentRolePlanV2(
  repositoryRoot: string,
  changeId: string,
): AgentRolePlanV2 | null {
  const overridePath = agentRolePlanV2Path(changeId);
  const overrideBytes = readCurrentPolicyBytes(repositoryRoot, overridePath, {
    kind: 'agent-role-plan',
    optional: true,
  });
  if (overrideBytes === null) return null;

  const centralBytes =
    readCurrentCentralRoleProviderDefaultPolicyBytes(repositoryRoot);
  const central = parseCurrentCentralRoleProviderDefaultPolicy(centralBytes);
  const revalidatedOverrideBytes = readCurrentPolicyBytes(
    repositoryRoot,
    overridePath,
    { kind: 'agent-role-plan', optional: true },
  );
  const revalidatedCentralBytes =
    readCurrentCentralRoleProviderDefaultPolicyBytes(repositoryRoot);
  if (
    revalidatedOverrideBytes === null ||
    !overrideBytes.equals(revalidatedOverrideBytes) ||
    !centralBytes.equals(revalidatedCentralBytes)
  ) {
    throw agentRolePlanInvalid(
      'Agent-role plan or central role/provider default changed while their exact pair was read.',
    );
  }
  return parseCurrentAgentRolePlanV2(overrideBytes, changeId, central);
}

export function readCurrentPlanningRoleOverridePolicy(
  repositoryRoot: string,
  changeId: string,
): CurrentPlanningRoleOverridePolicy | null {
  const override = readCurrentPlanningAgentRolePlanV2(repositoryRoot, changeId);
  if (override === null) return null;
  return projectCurrentPlanningRoleOverridePolicy(override);
}

function readCurrentCentralRoleProviderDefaultPolicyBytes(
  repositoryRoot: string,
): Buffer {
  const bytes = readCurrentPolicyBytes(
    repositoryRoot,
    CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
    {
      kind: 'central-role-provider-default',
      optional: false,
    },
  );
  if (bytes === null) {
    throw policyError(
      'CENTRAL_ROLE_PROVIDER_DEFAULT_UNAVAILABLE',
      'Central role/provider default is unavailable.',
    );
  }
  return bytes;
}

function readCurrentPolicyBytes(
  repositoryRoot: string,
  relativePath: string,
  options: PolicyReadOptions,
): Buffer | null {
  try {
    const root = canonicalRepositoryRoot(repositoryRoot, options.kind);
    const absolutePath = path.join(root, relativePath);
    const parentPath = path.dirname(absolutePath);
    const parent = fs.lstatSync(parentPath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (parent === undefined) {
      return missingPolicy(options);
    }
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      fs.realpathSync(parentPath) !== parentPath
    ) {
      throw unsafePolicy(options.kind);
    }

    const before = fs.lstatSync(absolutePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (before === undefined) return missingPolicy(options);
    assertSafePolicyStats(before, options.kind);

    const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
    const descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | noFollow,
    );
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      assertSafePolicyStats(opened, options.kind);
      if (!sameStableStats(before, opened)) {
        throw unsafePolicy(options.kind);
      }
      const bytes = readBounded(descriptor, options.kind);
      const afterRead = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(absolutePath, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        current === undefined ||
        BigInt(bytes.length) !== opened.size ||
        !sameStableStats(opened, afterRead) ||
        !sameStableStats(opened, current) ||
        fs.realpathSync(absolutePath) !== absolutePath
      ) {
        throw unsafePolicy(options.kind);
      }
      return bytes;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (isPolicyReaderError(error)) throw error;
    throw unsafePolicy(options.kind);
  }
}

function canonicalRepositoryRoot(
  repositoryRoot: string,
  kind: PolicyKind,
): string {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw unsafePolicy(kind);
  }
  return root;
}

function assertSafePolicyStats(stats: fs.BigIntStats, kind: PolicyKind): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    (stats.mode & 0o111n) !== 0n ||
    (process.platform !== 'win32' && (stats.mode & 0o777n) !== 0o644n) ||
    stats.size < 1n ||
    stats.size > BigInt(MAX_POLICY_BYTES)
  ) {
    throw unsafePolicy(kind);
  }
}

function readBounded(descriptor: number, kind: PolicyKind): Buffer {
  const buffer = Buffer.allocUnsafe(MAX_POLICY_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset === 0 || offset > MAX_POLICY_BYTES) throw unsafePolicy(kind);
  return buffer.subarray(0, offset);
}

function sameStableStats(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function missingPolicy(options: PolicyReadOptions): null {
  if (options.optional) return null;
  throw policyError(
    'CENTRAL_ROLE_PROVIDER_DEFAULT_UNAVAILABLE',
    'Central role/provider default is unavailable.',
  );
}

function unsafePolicy(kind: PolicyKind) {
  return kind === 'agent-role-plan'
    ? agentRolePlanInvalid(
        'Agent-role plan must be one stable bounded 0644 regular file.',
      )
    : policyError(
        'CENTRAL_ROLE_PROVIDER_DEFAULT_UNSAFE',
        'Central role/provider default storage is unsafe.',
      );
}

function agentRolePlanInvalid(message: string) {
  return workflowError(
    'AGENT_ROLE_PLAN_INVALID',
    message,
    ExitCode.verification,
  );
}

function policyError(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}

function isPolicyReaderError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code === 'AGENT_ROLE_PLAN_INVALID' ||
      error.code.startsWith('CENTRAL_ROLE_PROVIDER_DEFAULT_'))
  );
}
