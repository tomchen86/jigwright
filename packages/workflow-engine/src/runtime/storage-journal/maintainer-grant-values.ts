/**
 * Supplies maintainer grant timestamp, root, text, and error validation.
 *
 * Invariants:
 * - Accepted roots and timestamps retain their existing canonical forms.
 * - Unavailable, missing, ambiguous, and unsafe grants retain distinct errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw workflowError(
      'MAINTAINER_GRANT_TIME_INVALID',
      'Maintainer grant state requires an exact timestamp.',
      ExitCode.guard,
    );
  }
  return date;
}

export function isExactTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function canonicalRoot(value: string): string {
  if (!path.isAbsolute(value) || fs.realpathSync(value) !== value) {
    throw unsafeStore();
  }
  return value;
}

export function nonEmpty(value: string, label: string): string {
  if (!value || value.trim() !== value) {
    throw workflowError(
      'MAINTAINER_RESERVATION_INVALID',
      `Maintainer ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

export function unavailableGrant(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_UNAVAILABLE',
    `Maintainer grant ${grantId} is not available for this transition.`,
    ExitCode.conflict,
  );
}

export function grantNotFound(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_NOT_FOUND',
    `Maintainer grant ${grantId} does not exist in local state.`,
    ExitCode.guard,
  );
}

export function ambiguousGrant(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_STATE_AMBIGUOUS',
    `Maintainer grant ${grantId} has ambiguous or malformed local state.`,
    ExitCode.staleState,
  );
}

export function unsafeStore() {
  return workflowError(
    'MAINTAINER_GRANT_STORE_UNSAFE',
    'Maintainer grant storage is malformed or unsafe.',
    ExitCode.staleState,
  );
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
