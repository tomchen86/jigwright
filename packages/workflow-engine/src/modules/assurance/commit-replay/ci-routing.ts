/** Canonical commit replay contracts and pure predicates. */
import crypto from 'node:crypto';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';

export const HANDOFF_PATH = 'docs/CURRENT_AND_NEXT_STEPS.md';

export function digestBytes(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function routeReportInvalid() {
  return routeInvalid(
    'CI_CHANGE_ROUTING_REPORT_INVALID',
    'The route commit report is missing, malformed, non-canonical, or does not bind the committed projection.',
  );
}

export function routeInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
