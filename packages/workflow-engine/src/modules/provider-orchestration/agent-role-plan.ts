import crypto from 'node:crypto';

import {
  canonicalJson,
  compareCanonicalStrings,
} from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { agentRolePlanV2Path } from '../source/planning-role-policy-paths.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SAFE_LOGICAL_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
const ROLE_ORDER = ['author', 'builder', 'reviewer'] as const;
const ROLE_PAIR_ORDER = [
  'author-builder',
  'author-reviewer',
  'builder-reviewer',
] as const;

export type AgentRole = (typeof ROLE_ORDER)[number];
export type AgentRolePair = (typeof ROLE_PAIR_ORDER)[number];
export type AgentRoleScopeRule = 'planning-generation' | 'task' | 'candidate';
export type AgentRoleIndependenceRequirement =
  'provider-independent' | 'session-independent' | 'none';
export type AgentCustomWrapperPolicy =
  'forbidden' | 'allowed-non-protected' | 'allowed';

export type AgentRoleLaneV1 = Readonly<{
  role: AgentRole;
  scopeRule: AgentRoleScopeRule;
  allowedProviderFamilies: readonly string[];
  preferredLogicalProviderIds: readonly string[];
}>;

export type AgentPairwiseRequirementV1 = Readonly<{
  pair: AgentRolePair;
  required: AgentRoleIndependenceRequirement;
}>;

export type AgentRolePlanBodyV1 = Readonly<{
  schemaVersion: 1;
  changeId: string;
  planningGeneration: string;
  roleLanes: readonly AgentRoleLaneV1[];
  pairwiseRequirements: readonly AgentPairwiseRequirementV1[];
  customWrapperPolicy: AgentCustomWrapperPolicy;
  grantReferences: readonly string[];
}>;

export type AgentRolePlanV1 = AgentRolePlanBodyV1 &
  Readonly<{
    planDigest: string;
  }>;

export type AgentRolePlanBodyV2 = Readonly<{
  schemaVersion: 2;
  changeId: string;
  baseCentralConfigurationDigest: string;
  roleLanes: readonly AgentRoleLaneV1[];
  pairwiseRequirements: readonly AgentPairwiseRequirementV1[];
  customWrapperPolicy: AgentCustomWrapperPolicy;
  grantReferences: readonly string[];
}>;

export type AgentRolePlanV2 = AgentRolePlanBodyV2 &
  Readonly<{
    planDigest: string;
  }>;

export type AgentRolePlanV2Snapshot = Readonly<{
  schemaVersion: 1;
  kind: 'agent-role-plan-v2-snapshot';
  pinnedCommit: string;
  artifactPath: string;
  blobObjectId: string;
  sourceDigest: string;
  planDigest: string;
  plan: AgentRolePlanV2;
  snapshotDigest: string;
}>;

export type AgentRolePlanV2SnapshotVerifierPort = (
  snapshot: AgentRolePlanV2Snapshot,
) => AgentRolePlanV2Snapshot;

/** Historical V1 remains readable, while newly authored overrides are V2. */
export type AgentRolePlan = AgentRolePlanV1 | AgentRolePlanV2;
export type CurrentAgentRolePlan = AgentRolePlanV2;

export type AgentRolePlanReaderPort = Readonly<{
  readCurrent(
    repositoryRoot: string,
    changeId: string,
    planningGeneration: string,
  ): AgentRolePlanV1 | null;
  readPinned(
    repositoryRoot: string,
    commit: string,
    changeId: string,
    planningGeneration: string,
  ): AgentRolePlanV1 | null;
}>;

export type AgentRolePlanV2ReaderPort = Readonly<{
  readCurrent(
    repositoryRoot: string,
    changeId: string,
    baseCentralConfigurationDigest: string,
  ): AgentRolePlanV2 | null;
  readPinned(
    repositoryRoot: string,
    commit: string,
    changeId: string,
    baseCentralConfigurationDigest: string,
  ): AgentRolePlanV2 | null;
}>;

export function agentRolePlanDigest(value: AgentRolePlanBodyV1): string {
  const body = assertAgentRolePlanBody(
    value,
    value.changeId,
    value.planningGeneration,
  );
  return digestBody(body);
}

export function renderAgentRolePlan(value: AgentRolePlanV1): string {
  const plan = assertAgentRolePlan(
    value,
    value.changeId,
    value.planningGeneration,
  );
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function parseAgentRolePlan(
  source: string,
  expectedChangeId: string,
  expectedPlanningGeneration: string,
): AgentRolePlanV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw planInvalid('Agent-role plan must be valid JSON.');
  }
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'schemaVersion') &&
    value.schemaVersion !== 1
  ) {
    throw workflowError(
      'AGENT_ROLE_PLAN_VERSION_UNSUPPORTED',
      'Agent-role plan schema version is not supported.',
      ExitCode.verification,
    );
  }
  const plan = assertAgentRolePlan(
    value,
    expectedChangeId,
    expectedPlanningGeneration,
  );
  if (source !== renderAgentRolePlan(plan)) {
    throw planInvalid('Agent-role plan must use the canonical JSON encoding.');
  }
  return plan;
}

export function agentRolePlanV2Digest(value: AgentRolePlanBodyV2): string {
  const body = assertAgentRolePlanBodyV2(
    value,
    value.changeId,
    value.baseCentralConfigurationDigest,
  );
  return digestBodyV2(body);
}

export function renderAgentRolePlanV2(value: AgentRolePlanV2): string {
  const plan = assertAgentRolePlanV2(
    value,
    value.changeId,
    value.baseCentralConfigurationDigest,
  );
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function parseAgentRolePlanV2(
  source: string,
  expectedChangeId: string,
  expectedBaseCentralConfigurationDigest: string,
): AgentRolePlanV2 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw planInvalid('Agent-role plan must be valid JSON.');
  }
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'schemaVersion') &&
    value.schemaVersion !== 2
  ) {
    throw workflowError(
      'AGENT_ROLE_PLAN_VERSION_UNSUPPORTED',
      'Agent-role plan schema version is not supported.',
      ExitCode.verification,
    );
  }
  const plan = assertAgentRolePlanV2(
    value,
    expectedChangeId,
    expectedBaseCentralConfigurationDigest,
  );
  if (source !== renderAgentRolePlanV2(plan)) {
    throw planInvalid('Agent-role plan must use the canonical JSON encoding.');
  }
  return plan;
}

/**
 * Bind canonical V2 plan bytes to their claimed commit/blob identities. This
 * constructor proves the cryptographic fields only; production membership is
 * established by the pinned repository reader and its revalidation port.
 */
export function createAgentRolePlanV2Snapshot(
  value: Readonly<{
    pinnedCommit: string;
    blobObjectId: string;
    plan: AgentRolePlanV2;
  }>,
): AgentRolePlanV2Snapshot {
  return materializeAgentRolePlanV2Snapshot(value);
}

/** Validate snapshot binding only; repository membership requires its verifier. */
export function assertAgentRolePlanV2Snapshot(
  value: unknown,
): AgentRolePlanV2Snapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactPath',
      'blobObjectId',
      'kind',
      'pinnedCommit',
      'plan',
      'planDigest',
      'schemaVersion',
      'snapshotDigest',
      'sourceDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-role-plan-v2-snapshot' ||
    typeof value.pinnedCommit !== 'string' ||
    !FULL_OBJECT_ID.test(value.pinnedCommit) ||
    typeof value.blobObjectId !== 'string' ||
    typeof value.sourceDigest !== 'string' ||
    !DIGEST.test(value.sourceDigest) ||
    typeof value.planDigest !== 'string' ||
    !DIGEST.test(value.planDigest) ||
    typeof value.snapshotDigest !== 'string' ||
    !DIGEST.test(value.snapshotDigest) ||
    !isRecord(value.plan)
  ) {
    throw planInvalid('Agent-role plan snapshot is invalid.');
  }
  const expected = materializeAgentRolePlanV2Snapshot({
    pinnedCommit: value.pinnedCommit,
    blobObjectId: value.blobObjectId,
    plan: value.plan as unknown as AgentRolePlanV2,
  });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw planInvalid('Agent-role plan snapshot binding does not match.');
  }
  return expected;
}

function materializeAgentRolePlanV2Snapshot(
  value: Readonly<{
    pinnedCommit: string;
    blobObjectId: string;
    plan: AgentRolePlanV2;
  }>,
): AgentRolePlanV2Snapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['blobObjectId', 'pinnedCommit', 'plan']) ||
    typeof value.pinnedCommit !== 'string' ||
    !FULL_OBJECT_ID.test(value.pinnedCommit) ||
    typeof value.blobObjectId !== 'string' ||
    !isRecord(value.plan)
  ) {
    throw planInvalid('Agent-role plan snapshot identity is invalid.');
  }
  const plan = assertAgentRolePlanV2(
    value.plan,
    String(value.plan.changeId),
    String(value.plan.baseCentralConfigurationDigest),
  );
  const source = renderAgentRolePlanV2(plan);
  const objectFormat = value.pinnedCommit.length === 40 ? 'sha1' : 'sha256';
  const blobObjectId = crypto
    .createHash(objectFormat)
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
  if (value.blobObjectId !== blobObjectId) {
    throw planInvalid('Agent-role plan snapshot blob does not match.');
  }
  const body: Omit<AgentRolePlanV2Snapshot, 'snapshotDigest'> = {
    schemaVersion: 1,
    kind: 'agent-role-plan-v2-snapshot',
    pinnedCommit: value.pinnedCommit,
    artifactPath: agentRolePlanV2Path(plan.changeId),
    blobObjectId,
    sourceDigest: crypto.createHash('sha256').update(source).digest('hex'),
    planDigest: plan.planDigest,
    plan,
  };
  return deepFreeze({
    ...body,
    snapshotDigest: crypto
      .createHash('sha256')
      .update(`workflow.agent-role-plan-v2-snapshot.v1\n${canonicalJson(body)}`)
      .digest('hex'),
  });
}

function assertAgentRolePlan(
  value: unknown,
  expectedChangeId: string,
  expectedPlanningGeneration: string,
): AgentRolePlanV1 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role plan must be one object.');
  }
  assertExactKeys(value, [
    'changeId',
    'customWrapperPolicy',
    'grantReferences',
    'pairwiseRequirements',
    'planDigest',
    'planningGeneration',
    'roleLanes',
    'schemaVersion',
  ]);
  const body = assertAgentRolePlanBody(
    {
      schemaVersion: value.schemaVersion,
      changeId: value.changeId,
      planningGeneration: value.planningGeneration,
      roleLanes: value.roleLanes,
      pairwiseRequirements: value.pairwiseRequirements,
      customWrapperPolicy: value.customWrapperPolicy,
      grantReferences: value.grantReferences,
    },
    expectedChangeId,
    expectedPlanningGeneration,
  );
  if (
    typeof value.planDigest !== 'string' ||
    !DIGEST.test(value.planDigest) ||
    value.planDigest !== digestBody(body)
  ) {
    throw planInvalid('Agent-role plan digest does not match its exact body.');
  }
  return Object.freeze({ ...body, planDigest: value.planDigest });
}

function assertAgentRolePlanBody(
  value: unknown,
  expectedChangeId: string,
  expectedPlanningGeneration: string,
): AgentRolePlanBodyV1 {
  if (
    !CHANGE_ID.test(expectedChangeId) ||
    expectedChangeId === 'archive' ||
    !DIGEST.test(expectedPlanningGeneration) ||
    !isRecord(value)
  ) {
    throw planInvalid('Agent-role plan identity is invalid.');
  }
  assertExactKeys(value, [
    'changeId',
    'customWrapperPolicy',
    'grantReferences',
    'pairwiseRequirements',
    'planningGeneration',
    'roleLanes',
    'schemaVersion',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.changeId !== expectedChangeId ||
    value.planningGeneration !== expectedPlanningGeneration ||
    !Array.isArray(value.roleLanes) ||
    value.roleLanes.length > ROLE_ORDER.length ||
    !Array.isArray(value.pairwiseRequirements) ||
    value.pairwiseRequirements.length > ROLE_PAIR_ORDER.length ||
    !isCustomWrapperPolicy(value.customWrapperPolicy)
  ) {
    throw planInvalid('Agent-role plan fields are invalid.');
  }

  const roleLanes = value.roleLanes.map(assertRoleLane);
  assertCanonicalEnumOrder(
    roleLanes.map(({ role }) => role),
    ROLE_ORDER,
  );
  const pairwiseRequirements = value.pairwiseRequirements.map(
    assertPairwiseRequirement,
  );
  assertCanonicalEnumOrder(
    pairwiseRequirements.map(({ pair }) => pair),
    ROLE_PAIR_ORDER,
  );
  const grantReferences = assertCanonicalLogicalIds(value.grantReferences);

  return Object.freeze({
    schemaVersion: 1,
    changeId: value.changeId,
    planningGeneration: value.planningGeneration,
    roleLanes: Object.freeze(roleLanes),
    pairwiseRequirements: Object.freeze(pairwiseRequirements),
    customWrapperPolicy: value.customWrapperPolicy,
    grantReferences,
  });
}

function assertAgentRolePlanV2(
  value: unknown,
  expectedChangeId: string,
  expectedBaseCentralConfigurationDigest: string,
): AgentRolePlanV2 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role plan must be one object.');
  }
  assertExactKeys(value, [
    'baseCentralConfigurationDigest',
    'changeId',
    'customWrapperPolicy',
    'grantReferences',
    'pairwiseRequirements',
    'planDigest',
    'roleLanes',
    'schemaVersion',
  ]);
  const body = assertAgentRolePlanBodyV2(
    {
      schemaVersion: value.schemaVersion,
      changeId: value.changeId,
      baseCentralConfigurationDigest: value.baseCentralConfigurationDigest,
      roleLanes: value.roleLanes,
      pairwiseRequirements: value.pairwiseRequirements,
      customWrapperPolicy: value.customWrapperPolicy,
      grantReferences: value.grantReferences,
    },
    expectedChangeId,
    expectedBaseCentralConfigurationDigest,
  );
  if (
    typeof value.planDigest !== 'string' ||
    !DIGEST.test(value.planDigest) ||
    value.planDigest !== digestBodyV2(body)
  ) {
    throw planInvalid('Agent-role plan digest does not match its exact body.');
  }
  return Object.freeze({ ...body, planDigest: value.planDigest });
}

function assertAgentRolePlanBodyV2(
  value: unknown,
  expectedChangeId: string,
  expectedBaseCentralConfigurationDigest: string,
): AgentRolePlanBodyV2 {
  if (
    !CHANGE_ID.test(expectedChangeId) ||
    expectedChangeId === 'archive' ||
    !DIGEST.test(expectedBaseCentralConfigurationDigest) ||
    !isRecord(value)
  ) {
    throw planInvalid('Agent-role plan identity is invalid.');
  }
  assertExactKeys(value, [
    'baseCentralConfigurationDigest',
    'changeId',
    'customWrapperPolicy',
    'grantReferences',
    'pairwiseRequirements',
    'roleLanes',
    'schemaVersion',
  ]);
  if (
    value.schemaVersion !== 2 ||
    value.changeId !== expectedChangeId ||
    value.baseCentralConfigurationDigest !==
      expectedBaseCentralConfigurationDigest ||
    !Array.isArray(value.roleLanes) ||
    value.roleLanes.length > ROLE_ORDER.length ||
    !Array.isArray(value.pairwiseRequirements) ||
    value.pairwiseRequirements.length > ROLE_PAIR_ORDER.length ||
    !isCustomWrapperPolicy(value.customWrapperPolicy)
  ) {
    throw planInvalid('Agent-role plan fields are invalid.');
  }

  const roleLanes = value.roleLanes.map(assertRoleLane);
  assertCanonicalEnumOrder(
    roleLanes.map(({ role }) => role),
    ROLE_ORDER,
  );
  const pairwiseRequirements = value.pairwiseRequirements.map(
    assertPairwiseRequirement,
  );
  assertCanonicalEnumOrder(
    pairwiseRequirements.map(({ pair }) => pair),
    ROLE_PAIR_ORDER,
  );
  const grantReferences = assertCanonicalLogicalIds(value.grantReferences);

  return Object.freeze({
    schemaVersion: 2,
    changeId: value.changeId,
    baseCentralConfigurationDigest: value.baseCentralConfigurationDigest,
    roleLanes: Object.freeze(roleLanes),
    pairwiseRequirements: Object.freeze(pairwiseRequirements),
    customWrapperPolicy: value.customWrapperPolicy,
    grantReferences,
  });
}

function assertRoleLane(value: unknown): AgentRoleLaneV1 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role lane must be one object.');
  }
  assertExactKeys(value, [
    'allowedProviderFamilies',
    'preferredLogicalProviderIds',
    'role',
    'scopeRule',
  ]);
  if (!isAgentRole(value.role) || !isScopeRule(value.scopeRule)) {
    throw planInvalid('Agent-role lane fields are invalid.');
  }
  return Object.freeze({
    role: value.role,
    scopeRule: value.scopeRule,
    allowedProviderFamilies: assertCanonicalLogicalIds(
      value.allowedProviderFamilies,
    ),
    preferredLogicalProviderIds: assertCanonicalLogicalIds(
      value.preferredLogicalProviderIds,
    ),
  });
}

function assertPairwiseRequirement(value: unknown): AgentPairwiseRequirementV1 {
  if (!isRecord(value)) {
    throw planInvalid('Agent-role pairwise requirement must be one object.');
  }
  assertExactKeys(value, ['pair', 'required']);
  if (!isAgentRolePair(value.pair) || !isRequirement(value.required)) {
    throw planInvalid('Agent-role pairwise requirement fields are invalid.');
  }
  return Object.freeze({ pair: value.pair, required: value.required });
}

function assertCanonicalLogicalIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw planInvalid('Agent-role logical identifiers must be one array.');
  }
  const identifiers = value.map((candidate) => {
    if (
      typeof candidate !== 'string' ||
      !SAFE_LOGICAL_ID.test(candidate) ||
      candidate.includes('..')
    ) {
      throw planInvalid('Agent-role logical identifier is unsafe.');
    }
    return candidate;
  });
  for (let index = 1; index < identifiers.length; index += 1) {
    if (
      compareCanonicalStrings(identifiers[index - 1]!, identifiers[index]!) >= 0
    ) {
      throw planInvalid(
        'Agent-role logical identifiers must be unique and canonically sorted.',
      );
    }
  }
  return Object.freeze(identifiers);
}

function assertCanonicalEnumOrder<T extends string>(
  values: readonly T[],
  canonicalOrder: readonly T[],
): void {
  let previous = -1;
  for (const value of values) {
    const current = canonicalOrder.indexOf(value);
    if (current <= previous) {
      throw planInvalid(
        'Agent-role entries must be unique and in canonical order.',
      );
    }
    previous = current;
  }
}

function digestBody(value: AgentRolePlanBodyV1): string {
  return crypto
    .createHash('sha256')
    .update('agent-role-plan-v1\0')
    .update(canonicalJson(value))
    .digest('hex');
}

function digestBodyV2(value: AgentRolePlanBodyV2): string {
  return crypto
    .createHash('sha256')
    .update('agent-role-plan-v2\0')
    .update(canonicalJson(value))
    .digest('hex');
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const required = [...expected].sort(compareCanonicalStrings);
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  ) {
    throw planInvalid('Agent-role plan fields are not exact.');
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCanonicalStrings);
  const required = [...expected].sort(compareCanonicalStrings);
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function isAgentRole(value: unknown): value is AgentRole {
  return ROLE_ORDER.some((role) => role === value);
}

function isAgentRolePair(value: unknown): value is AgentRolePair {
  return ROLE_PAIR_ORDER.some((pair) => pair === value);
}

function isScopeRule(value: unknown): value is AgentRoleScopeRule {
  return (
    value === 'planning-generation' || value === 'task' || value === 'candidate'
  );
}

function isRequirement(
  value: unknown,
): value is AgentRoleIndependenceRequirement {
  return (
    value === 'provider-independent' ||
    value === 'session-independent' ||
    value === 'none'
  );
}

function isCustomWrapperPolicy(
  value: unknown,
): value is AgentCustomWrapperPolicy {
  return (
    value === 'forbidden' ||
    value === 'allowed-non-protected' ||
    value === 'allowed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function planInvalid(message: string): ReturnType<typeof workflowError> {
  return workflowError(
    'AGENT_ROLE_PLAN_INVALID',
    message,
    ExitCode.verification,
  );
}
