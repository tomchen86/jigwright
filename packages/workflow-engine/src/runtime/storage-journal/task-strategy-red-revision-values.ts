/**
 * Defines RED revision phases, exact identity checks, and stable failure codes.
 *
 * Invariants:
 * - The ordered revision phases and all identity bounds retain their original values.
 * - Canonical digests and corruption, request, and phase errors remain unchanged.
 */
import { assertSessionId } from '../session-workspace/paths.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import crypto from 'node:crypto';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const TASK_ID = /^\d+(?:\.\d+)+$/;

export const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const REVISION_ID = /^red-revision-[0-9a-f]{64}$/;

export const MAX_REASON_BYTES = 4096;

export const TASK_STRATEGY_RED_REVISION_PHASES = Object.freeze([
  'prepared',
  'implementation-restored',
  'current-authoring',
  'session-evidence-cleared',
  'reseal-prepared',
  'successor-persisted',
  'current-sealed',
  'completed',
] as const);

export type TaskStrategyRedRevisionPhase =
  (typeof TASK_STRATEGY_RED_REVISION_PHASES)[number];

export function assertRevisionId(value: string): string {
  if (!REVISION_ID.test(value)) throw revisionStateCorrupt();
  return value;
}

export function isRevisionId(value: unknown): value is string {
  return typeof value === 'string' && REVISION_ID.test(value);
}

export function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return assertSessionId(value) === value;
  } catch {
    return false;
  }
}

export function isRevisionPhase(
  value: unknown,
): value is TaskStrategyRedRevisionPhase {
  return TASK_STRATEGY_RED_REVISION_PHASES.includes(
    value as TaskStrategyRedRevisionPhase,
  );
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && GIT_OBJECT_ID.test(value);
}

export function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

export function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function revisionRequestInvalid() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
    'Task strategy RED revision input is malformed or unsafe.',
    ExitCode.usage,
  );
}

export function revisionPhaseInvalid() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_PHASE_INVALID',
    'Task strategy RED revision journal cannot skip, repeat with changed data, or move backwards.',
    ExitCode.conflict,
  );
}

export function revisionStateCorrupt() {
  return workflowError(
    'TASK_STRATEGY_RED_REVISION_STATE_CORRUPT',
    'Task strategy RED revision state is malformed or unsafe.',
    ExitCode.staleState,
  );
}
