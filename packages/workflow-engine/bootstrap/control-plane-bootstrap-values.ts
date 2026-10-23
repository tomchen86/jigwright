/** Shared bootstrap constants, canonical values, and exact error construction. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import type { Sha256Digest } from './control-plane-bootstrap-types.ts';

export const PRIVATE_DIRECTORY_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

export const MAX_STATE_BYTES = 4 * 1024 * 1024;

export const MAX_CLOSURE_FILE_BYTES = 16 * 1024 * 1024;

export const RECOVERY_QUARANTINE_GRANT_ID =
  /^quarantine-(?:enter|release)-[0-9a-f]{64}$/;

export const RECOVERY_QUARANTINE_HISTORY_DIRECTORY = /^[0-9a-f]{64}$/;

export const RECOVERY_QUARANTINE_CLAIM_FILE = /^[0-9a-f]{64}\.json$/;

export const PROCESS_TIMEOUT_MS = 10_000;

export const BUILT_IN_BOOTSTRAP_RUNTIME_PATHS = [
  'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
  'packages/workflow-engine/bootstrap/canonical-json.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-closure.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-files.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-local.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-quarantine.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-types.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-values.ts',
  'packages/workflow-engine/bootstrap/control-plane-trust.ts',
  'packages/workflow-engine/bootstrap/harness-bootstrap-production.ts',
  'packages/workflow-engine/bootstrap/maintainer-authority-production.ts',
  'packages/workflow-engine/bootstrap/session-lifecycle-production.ts',
  'packages/workflow-engine/bootstrap/workflow-bootstrap-host.ts',
  'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
] as const;

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function verifyRecordDigest(record: Record<string, unknown>): boolean {
  if (!isDigest(record.recordDigest)) return false;
  const { recordDigest, ...payload } = record;
  return canonicalDigest(payload) === recordDigest;
}

export function identityFileName(kind: string, identity: string): string {
  return crypto
    .createHash('sha256')
    .update(`${kind}\0${identity}`)
    .digest('hex');
}

export function parentChangeIdFromBranch(
  branchRef: string | null,
): string | null {
  const prefix = 'refs/heads/work/';
  if (branchRef === null || !branchRef.startsWith(prefix)) return null;
  const parentChangeId = branchRef.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parentChangeId)
    ? parentChangeId
    : null;
}

export function safeClosurePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.normalize('NFC') &&
    !path.isAbsolute(value) &&
    !value.includes('\\') &&
    !/[*?[\]{}]/.test(value) &&
    value
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function isNonEmptyTrimmed(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

export function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(canonicalJson(value));
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function localBindingMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_BINDING_MISMATCH',
    'Local engine binding disagrees with its exact worktree or adoption journal.',
    13,
  );
}

export function interventionFenceCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_PARENT_INTERVENTION_FENCE_CORRUPT',
    'Parent intervention fence failed canonical integrity verification.',
    13,
  );
}

export function builtInClosureMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH',
    'Built-in E1 closure is missing, indirect, stale, or has changed bytes.',
    13,
  );
}

export function recoveryQuarantineStateCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_RECOVERY_QUARANTINE_STATE_CORRUPT',
    'Recovery Quarantine state is unknown, incomplete, indirect, or failed canonical integrity verification.',
    13,
  );
}

export function trustError(
  code: string,
  message: string,
  exitCode: number,
): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message), { code, exitCode });
}
