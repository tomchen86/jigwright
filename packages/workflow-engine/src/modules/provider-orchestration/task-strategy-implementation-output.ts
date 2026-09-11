/**
 * Validates implementation patch output and optionally binds it to a sealed
 * session and source tree.
 *
 * Invariants:
 * - Accepted patch bytes are nonempty, bounded, canonically encoded and
 *   consistent with their declared digest.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { ProviderOutputValidator } from './provider-contracts.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SESSION_ID = /^session-[a-zA-Z0-9-]+$/u;
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

export type TaskStrategyImplementationOutput = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-patch-output.v1';
  sessionId: string;
  sourceTree: string;
  patchBase64: string;
  patchDigest: string;
}>;

export type TaskStrategyImplementationOutputSubject = Readonly<{
  sessionId: string;
  sourceTree: string;
}>;

export const TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA =
  Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'kind',
      'sessionId',
      'sourceTree',
      'patchBase64',
      'patchDigest',
    ],
    properties: {
      schemaVersion: { const: 1 },
      kind: { const: 'task-strategy-patch-output.v1' },
      sessionId: { type: 'string', minLength: 1 },
      sourceTree: {
        type: 'string',
        pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
      },
      patchBase64: {
        type: 'string',
        minLength: 1,
        maxLength: Math.ceil(MAX_PATCH_BYTES / 3) * 4,
      },
      patchDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    },
  });

export const TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA = Object.freeze({
  id: 'workflow.task-strategy-implementation-output.v1',
  version: 1,
  digest: sha256(
    canonicalJson(TASK_STRATEGY_IMPLEMENTATION_PROVIDER_OUTPUT_SCHEMA),
  ),
});

export const TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR: ProviderOutputValidator =
  Object.freeze({
    ...TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      try {
        assertTaskStrategyImplementationOutput(value);
        return true;
      } catch {
        return false;
      }
    },
  });

/**
 * Bind semantic validation to the exact sealed implementation subject. The
 * static validator above remains the pure persisted-output parser; provider
 * completion must use this validator so another session or source tree cannot
 * turn structurally valid patch bytes into durable success.
 */
export function taskStrategyImplementationOutputValidator(
  subject: TaskStrategyImplementationOutputSubject,
): ProviderOutputValidator {
  if (
    !isRecord(subject) ||
    !hasExactKeys(subject, ['sessionId', 'sourceTree']) ||
    typeof subject.sessionId !== 'string' ||
    !SESSION_ID.test(subject.sessionId) ||
    typeof subject.sourceTree !== 'string' ||
    !GIT_OBJECT_ID.test(subject.sourceTree)
  ) {
    throw new TypeError('Invalid task strategy output subject.');
  }
  const exactSubject = deepFreeze(structuredClone(subject));
  return Object.freeze({
    ...TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      try {
        const output = assertTaskStrategyImplementationOutput(value);
        return (
          output.sessionId === exactSubject.sessionId &&
          output.sourceTree === exactSubject.sourceTree
        );
      } catch {
        return false;
      }
    },
  });
}

export function assertTaskStrategyImplementationOutput(
  value: unknown,
  invalid: () => Error = () => new TypeError('Invalid task strategy output.'),
): TaskStrategyImplementationOutput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'sessionId',
      'sourceTree',
      'patchBase64',
      'patchDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-patch-output.v1' ||
    typeof value.sessionId !== 'string' ||
    !SESSION_ID.test(value.sessionId) ||
    typeof value.sourceTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.sourceTree) ||
    typeof value.patchDigest !== 'string' ||
    !DIGEST.test(value.patchDigest) ||
    typeof value.patchBase64 !== 'string'
  ) {
    throw invalid();
  }
  const patch = Buffer.from(value.patchBase64, 'base64');
  if (
    patch.length === 0 ||
    patch.length > MAX_PATCH_BYTES ||
    patch.toString('base64') !== value.patchBase64 ||
    sha256(patch) !== value.patchDigest
  ) {
    throw invalid();
  }
  return deepFreeze(structuredClone(value)) as TaskStrategyImplementationOutput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
