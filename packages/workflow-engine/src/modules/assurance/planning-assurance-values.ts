/** Pure planning assurance value and error operations. */
import crypto from 'node:crypto';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function planningNotReady(message: string) {
  return workflowError(
    'OPENSPEC_CHANGE_NOT_READY',
    message,
    ExitCode.verification,
  );
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
