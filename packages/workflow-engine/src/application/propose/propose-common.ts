/**
 * Shared propose value checks, evidence keys, digests, and error identities.
 *
 * Invariants:
 * - Canonical digests, evidence keys, and failure codes retain their exact bytes.
 * - Shape checks reject malformed input without repairing or coercing it.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export const MAX_CALLER_JSON_BYTES = 4 * 1024 * 1024;

export const DIGEST = /^[0-9a-f]{64}$/;

export const PROPOSE_AUTHORIZATION_SCHEMA = 'workflow-propose-authorization.v3';

export const PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA =
  'workflow-propose-authorization-output.v3';

export const PLANNING_MATERIALIZATION_REF = 'propose/planning-materialization';

export const PLAN_REVIEW_REQUEST_REF = 'propose/plan-review-request';

export const PLAN_REVIEW_GRANT_REQUIREMENT_REF =
  'propose/plan-review-grant-requirement';

export const BLIND_SURVEY_GRANT_REASON =
  'No session-independent Reviewer pre-anchor turn is callable for this exact investigation.';

export const PLAN_REVIEW_GRANT_REASON =
  'No provider-independent exact-plan reviewer is callable for this exact planning generation.';

export function createRuntimeId(prefix: string): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '');
  return `${prefix}-${timestamp}-${crypto.randomUUID()}`;
}

export function isBaseline(value: unknown): value is {
  head: string;
  tree: string;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    typeof value.head === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) &&
    typeof value.tree === 'string' &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.tree)
  );
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function isDigestRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([relativePath, digest]) =>
        relativePath.length > 0 &&
        typeof digest === 'string' &&
        DIGEST.test(digest),
    )
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function proposeInputInvalid(detail?: string) {
  return workflowError(
    'PROPOSE_INPUT_INVALID',
    detail === undefined
      ? 'Propose input does not match a supported typed envelope.'
      : `Propose input does not match a supported typed envelope. ${detail}`,
    ExitCode.usage,
  );
}

/**
 * Say which envelope was expected and exactly how the supplied one differs.
 *
 * A caller that resumes a change assembles these by hand from the status
 * output, and a refusal that names neither the envelope nor the offending key
 * sends them to the engine source to find out which of eight shapes was meant.
 */
export function envelopeKeyDetail(
  kind: string,
  keys: readonly string[],
  value: unknown,
): string {
  const expected = [...keys].sort();
  if (!isRecord(value)) {
    return `A ${kind} envelope must be a JSON object carrying exactly: ${expected.join(', ')}.`;
  }
  const supplied = Object.keys(value).sort();
  const missing = expected.filter((key) => !supplied.includes(key));
  const unexpected = supplied.filter((key) => !expected.includes(key));
  const differences = [
    missing.length > 0 ? `missing ${missing.join(', ')}` : null,
    unexpected.length > 0 ? `unexpected ${unexpected.join(', ')}` : null,
  ].filter((entry): entry is string => entry !== null);
  return differences.length > 0
    ? `A ${kind} envelope must carry exactly: ${expected.join(', ')} (${differences.join('; ')}).`
    : `A ${kind} envelope carries the right keys, so one of its values is malformed. Expected: ${expected.join(', ')}.`;
}

export function proposeAuthorizationInvalid() {
  return workflowError(
    'PROPOSE_AUTHORIZATION_INVALID',
    'Durable propose actor and role authorization evidence is invalid.',
    ExitCode.staleState,
  );
}

export function planningMaterializationStale(message: string) {
  return workflowError(
    'PLANNING_MATERIALIZATION_STALE',
    message,
    ExitCode.staleState,
  );
}

export function planningContributionInvalid(
  message = 'Planning contribution is malformed.',
) {
  return workflowError(
    'PLANNING_CONTRIBUTION_INVALID',
    message,
    ExitCode.usage,
  );
}

export function planReviewRequestStale() {
  return workflowError(
    'PLAN_REVIEW_REQUEST_STALE',
    'Durable plan-review request reservation is invalid.',
    ExitCode.staleState,
  );
}
