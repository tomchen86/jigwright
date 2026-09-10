/**
 * Dispatches role-context-sharing approval and terminal-receipt commands.
 *
 * Invariants:
 * - Approval candidates require exact fields, a UUID v4 Grant identity, a
 *   bounded reason and a positive integer lifetime.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  approveAndStoreRoleContextSharingGrant,
  type RoleContextSharingGrantCandidate,
} from '../../composition-root/role-context-sharing-grant-approval-production.ts';
import { publishRoleContextSharingTerminalReceipt } from '../../composition-root/role-context-sharing-terminal-receipt-production.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertOptionalGrantsPackageAvailable } from '../../composition-root/optional-grants-package-production.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_INPUT_BYTES = 16 * 1024;

export function dispatchRoleContextSharingGrantCommand(
  args: string[],
  cwd: string,
): Record<string, unknown> {
  assertOptionalGrantsPackageAvailable();
  if (
    args.length === 4 &&
    args[0] === 'role-context-sharing-grant' &&
    args[1] === 'publish-terminal-receipt' &&
    args[2] === '--grant' &&
    UUID_V4.test(args[3]!)
  ) {
    const result = publishRoleContextSharingTerminalReceipt(cwd, args[3]!);
    return {
      action: 'role-context-sharing-grant.publish-terminal-receipt',
      ok: true,
      grantId: result.envelope.payload.grantId,
      state: result.envelope.payload.terminalState,
      terminalRecordDigest: result.envelope.payload.terminalRecordDigest,
      tagRef: result.tagRef,
      tagObject: result.tagObject,
      publishCommand: result.publishCommand,
    };
  }
  if (
    args.length !== 4 ||
    args[0] !== 'role-context-sharing-grant' ||
    args[1] !== 'approve-and-store' ||
    args[2] !== '--input'
  ) {
    throw roleContextSharingGrantUsage();
  }
  const inputPath = path.resolve(cwd, args[3]!);
  const stats = fs.lstatSync(inputPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > MAX_INPUT_BYTES
  ) {
    throw roleContextSharingGrantUsage();
  }
  const candidate = parseRoleContextSharingGrantCandidate(
    fs.readFileSync(inputPath, 'utf8'),
  );
  const result = approveAndStoreRoleContextSharingGrant(cwd, candidate);
  return {
    action: 'role-context-sharing-grant.approve-and-store',
    ok: true,
    grantId: result.envelope.payload.grantId,
    requirementNodeId: candidate.requirementNodeId,
    state: result.record.state,
    recordDigest: result.record.recordDigest,
  };
}

export function parseRoleContextSharingGrantCandidate(
  raw: string,
): RoleContextSharingGrantCandidate {
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) {
    throw roleContextSharingGrantUsage();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw roleContextSharingGrantUsage();
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        ['requirementNodeId', 'grantId', 'reason', 'ttlMinutes'].sort(),
      )
  ) {
    throw roleContextSharingGrantUsage();
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.requirementNodeId !== 'string' ||
    !DIGEST.test(candidate.requirementNodeId) ||
    typeof candidate.grantId !== 'string' ||
    !UUID_V4.test(candidate.grantId) ||
    typeof candidate.reason !== 'string' ||
    candidate.reason.trim() !== candidate.reason ||
    candidate.reason.length < 12 ||
    candidate.reason.length > 1_000 ||
    !Number.isSafeInteger(candidate.ttlMinutes) ||
    (candidate.ttlMinutes as number) < 1
  ) {
    throw roleContextSharingGrantUsage();
  }
  return Object.freeze({
    requirementNodeId: candidate.requirementNodeId,
    grantId: candidate.grantId,
    reason: candidate.reason,
    ttlMinutes: candidate.ttlMinutes as number,
  });
}

function roleContextSharingGrantUsage() {
  return workflowError(
    'INVALID_USAGE',
    'Usage: pnpm workflow maintainer role-context-sharing-grant <approve-and-store --input candidate.json | publish-terminal-receipt --grant uuid> [--json]',
    ExitCode.usage,
  );
}
