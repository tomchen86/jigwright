/**
 * Provides exact session value checks, lock errors, and descriptor durability helpers.
 *
 * Invariants:
 * - Digest, record, and lock-token acceptance rules remain unchanged.
 * - Directory synchronization closes its descriptor on success and failure.
 *
 * Depends on: Node filesystem primitives and workflow errors.
 * Failure modes: inconsistent session validation, leaked descriptors, or missing directory durability.
 */
import fs from 'node:fs';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

export const SESSION_LOCK_OWNER_TOKEN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function readDescriptorContent(
  descriptor: number,
  byteLength: number,
): string {
  const bytes = Buffer.alloc(byteLength);
  const count = fs.readSync(descriptor, bytes, 0, byteLength, 0);
  return bytes.subarray(0, count).toString('utf8');
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function isCommitHash(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

export function isCanonicalStringSet(value: string[]): boolean {
  return (
    new Set(value).size === value.length &&
    JSON.stringify(value) === JSON.stringify([...value].sort())
  );
}

export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}

export function invalidSessionLock() {
  return workflowError(
    'SESSION_LOCK_INVALID',
    'The active session lock is missing or does not match the session.',
    ExitCode.staleState,
  );
}

export function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
