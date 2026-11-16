/**
 * Creates and validates the public binding of a durable role assignment to
 * its provider profile and input manifests.
 *
 * Invariants:
 * - A binding must match both its embedded provider profile identity and
 *   its recomputed payload digest.
 */
import crypto from 'node:crypto';

import {
  assertAgentProviderProfileSnapshot,
  type AgentProviderProfileSnapshot,
} from '@jigwright/core/agent-provider-config';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Exact public projection of one durable current role assignment. */
export type AgentRuntimeAssignmentBindingV1 = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-assignment-binding.v1';
  changeId: string;
  planningGeneration: string;
  recordDigest: string;
  assignmentDigest: string;
  role: 'author' | 'builder' | 'reviewer';
  logicalProviderId: string;
  providerProfileId: string;
  providerProfileSnapshot: AgentProviderProfileSnapshot;
  definitionDigest: string;
  dataAuthorizationPolicyDigest: string;
  assignmentManifestDigest: string;
  inputManifestDigest: string;
  targetDigest: string;
  bindingDigest: string;
}>;

export type AgentRuntimeAssignmentBindingV1Input = Omit<
  AgentRuntimeAssignmentBindingV1,
  'bindingDigest'
>;

export function createAgentRuntimeAssignmentBindingV1(
  input: AgentRuntimeAssignmentBindingV1Input,
): AgentRuntimeAssignmentBindingV1 {
  const payload = structuredClone(input);
  return assertAgentRuntimeAssignmentBindingV1({
    ...payload,
    bindingDigest: digest(payload),
  });
}

export function assertAgentRuntimeAssignmentBindingV1(
  value: unknown,
): AgentRuntimeAssignmentBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'changeId',
      'planningGeneration',
      'recordDigest',
      'assignmentDigest',
      'role',
      'logicalProviderId',
      'providerProfileId',
      'providerProfileSnapshot',
      'definitionDigest',
      'dataAuthorizationPolicyDigest',
      'assignmentManifestDigest',
      'inputManifestDigest',
      'targetDigest',
      'bindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-assignment-binding.v1' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    value.changeId === 'archive' ||
    !['author', 'builder', 'reviewer'].includes(String(value.role)) ||
    typeof value.logicalProviderId !== 'string' ||
    value.logicalProviderId.length === 0 ||
    typeof value.providerProfileId !== 'string' ||
    value.providerProfileId.length === 0 ||
    [
      value.planningGeneration,
      value.recordDigest,
      value.assignmentDigest,
      value.definitionDigest,
      value.dataAuthorizationPolicyDigest,
      value.assignmentManifestDigest,
      value.inputManifestDigest,
      value.targetDigest,
      value.bindingDigest,
    ].some((candidate) => !isDigest(candidate))
  ) {
    throw new TypeError('Agent Runtime assignment binding is invalid.');
  }
  let providerProfileSnapshot: AgentProviderProfileSnapshot;
  try {
    if (
      !isRecord(value.providerProfileSnapshot) ||
      typeof value.providerProfileSnapshot.platform !== 'string'
    ) {
      throw new TypeError();
    }
    providerProfileSnapshot = assertAgentProviderProfileSnapshot(
      value.providerProfileSnapshot,
      value.providerProfileSnapshot.platform as NodeJS.Platform,
    );
  } catch {
    throw new TypeError('Agent Runtime assignment binding is invalid.');
  }
  const payload: Record<string, unknown> = {
    ...value,
    providerProfileSnapshot,
  };
  delete payload.bindingDigest;
  if (
    providerProfileSnapshot.id !== value.providerProfileId ||
    digest(payload) !== value.bindingDigest
  ) {
    throw new TypeError('Agent Runtime assignment binding is invalid.');
  }
  return deepFreeze(
    structuredClone({
      ...value,
      providerProfileSnapshot,
    }) as AgentRuntimeAssignmentBindingV1,
  );
}

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(
      `workflow.agent-runtime-assignment-binding.v1\n${canonicalJson(value)}`,
    )
    .digest('hex');
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
