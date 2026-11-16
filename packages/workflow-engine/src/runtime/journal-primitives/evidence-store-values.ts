/**
 * Supplies evidence path construction, exact value checks, digests, and errors.
 *
 * Invariants:
 * - Node and ref identifiers keep their current accepted syntax and paths.
 * - Canonical hashes and workflow error identities remain stable.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertInvestigationId } from '../../foundation/repository-path/repository-path.ts';

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const REF_NAME_PATTERN =
  /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function isBaseline(
  value: unknown,
): value is { head: string; tree: string } {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) &&
    typeof value.tree === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.tree)
  );
}

export function isDigestRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.entries(value).every(
      ([name, digest]) =>
        name.length > 0 && typeof digest === 'string' && isDigest(digest),
    )
  );
}

export function isInvestigationOwner(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return assertInvestigationId(value) === value;
  } catch {
    return false;
  }
}

export function evidenceObjectPath(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): string {
  return path.join(paths.objects, nodeId.slice(0, 2), `${nodeId}.json`);
}

export function evidenceRefPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.json`);
}

export function assertNodeId(nodeId: string): void {
  if (!DIGEST_PATTERN.test(nodeId)) {
    throw workflowError(
      'EVIDENCE_OBJECT_ID_INVALID',
      `Invalid evidence node identifier: ${nodeId}`,
      ExitCode.usage,
    );
  }
}

export function assertRefName(refName: string): void {
  if (typeof refName !== 'string' || !REF_NAME_PATTERN.test(refName)) {
    throw workflowError(
      'EVIDENCE_REF_NAME_INVALID',
      `Invalid evidence ref name: ${refName}`,
      ExitCode.usage,
    );
  }
}

export function objectUnsafe() {
  return workflowError(
    'EVIDENCE_OBJECT_UNSAFE',
    'Evidence object path is not a canonical no-follow location.',
    ExitCode.unsafeEnvironment,
  );
}

export function objectInvalid() {
  return workflowError(
    'EVIDENCE_OBJECT_INVALID',
    'Evidence object envelope is forged, tampered, or noncanonical.',
    ExitCode.staleState,
  );
}

export function objectCollision(nodeId: string) {
  return workflowError(
    'EVIDENCE_OBJECT_COLLISION',
    'A different evidence envelope already exists for this node identifier.',
    ExitCode.conflict,
    { details: { nodeId } },
  );
}

export function objectUnavailable(nodeId: string) {
  return workflowError(
    'EVIDENCE_OBJECT_UNAVAILABLE',
    'The next evidence node must already exist as a stored object.',
    ExitCode.staleState,
    { details: { nodeId } },
  );
}

export function refUnsafe() {
  return workflowError(
    'EVIDENCE_REF_UNSAFE',
    'Evidence ref path is not a canonical no-follow location.',
    ExitCode.unsafeEnvironment,
  );
}

export function refInvalid() {
  return workflowError(
    'EVIDENCE_REF_INVALID',
    'Evidence ref document is malformed or noncanonical.',
    ExitCode.staleState,
  );
}

export function refCasMismatch(
  refName: string,
  expectedNodeId: string | null,
  observedNodeId: string | null,
) {
  return workflowError(
    'EVIDENCE_REF_CAS_MISMATCH',
    'Evidence ref changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { refName, expectedNodeId, observedNodeId } },
  );
}

export function refsDocumentCasMismatch(
  expectedDigest: string | null,
  observedDigest: string | null,
  nextDigest: string | null,
) {
  return workflowError(
    'EVIDENCE_REFS_CAS_MISMATCH',
    'Evidence ref document changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedDigest, observedDigest, nextDigest } },
  );
}

export function refLocked(changeId: string) {
  return workflowError(
    'EVIDENCE_REF_LOCKED',
    'Evidence ref for this change is locked by another operation.',
    ExitCode.conflict,
    { details: { changeId } },
  );
}

export function refLockInvalid() {
  return workflowError(
    'EVIDENCE_REF_LOCK_INVALID',
    'Evidence ref lock ownership changed during the operation.',
    ExitCode.staleState,
  );
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
