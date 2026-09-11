/**
 * Defines central provider and session partitions, selection rules, and
 * pinned defaults.
 *
 * Invariants:
 * - Role partitions must cover the expected roles exactly once in canonical
 *   order.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { AgentRole } from './agent-role-plan.ts';

const ROLE_ORDER = ['author', 'builder', 'reviewer'] as const;
const LOGICAL_PROVIDER_ID = /^[a-z0-9][a-z0-9._:@+-]{0,127}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PROVIDER_PARTITIONS = [
  [['author'], ['builder'], ['reviewer']],
  [['author', 'builder'], ['reviewer']],
  [['author'], ['builder', 'reviewer']],
  [['author', 'reviewer'], ['builder']],
  [['author', 'builder', 'reviewer']],
] as const satisfies readonly (readonly (readonly AgentRole[])[])[];

export type CentralProviderRuleV1 =
  | Readonly<{ kind: 'adaptive-author' }>
  | Readonly<{
      kind: 'ranked-fallback';
      preferredLogicalProviderId: string | null;
    }>;

export type CentralProviderGroupRuleV1 = Readonly<{
  roles: readonly AgentRole[];
  sessionGroups: readonly (readonly AgentRole[])[];
  providerRule: CentralProviderRuleV1;
}>;

export type CentralRoleProviderDefaultBodyV1 = Readonly<{
  schemaVersion: 1;
  kind: 'central-role-provider-default';
  providerGroups: readonly CentralProviderGroupRuleV1[];
  globalProviderRanking: readonly string[];
}>;

export type CentralRoleProviderDefaultV1 = CentralRoleProviderDefaultBodyV1 &
  Readonly<{
    configurationDigest: string;
  }>;

export const CENTRAL_ROLE_PROVIDER_DEFAULT_PATH =
  'workflow/role-provider-default.json';

export type CentralRoleProviderDefaultSnapshotV1 = Readonly<{
  schemaVersion: 1;
  kind: 'central-role-provider-default-snapshot.v1';
  pinnedCommit: string;
  artifactPath: typeof CENTRAL_ROLE_PROVIDER_DEFAULT_PATH;
  blobObjectId: string;
  sourceDigest: string;
  configuration: CentralRoleProviderDefaultV1;
  snapshotDigest: string;
}>;

export type CentralRoleProviderDefaultSnapshotVerifierPort = (
  snapshot: CentralRoleProviderDefaultSnapshotV1,
) => CentralRoleProviderDefaultSnapshotV1;

export type ProviderPartitionChoiceV1 = Readonly<{
  option: 1 | 2 | 3 | 4 | 5;
  groups: readonly (readonly AgentRole[])[];
  notation: string;
}>;

export type SessionPartitionChoiceV1 = Readonly<{
  option: 1 | 2 | 3 | 4 | 5;
  sessionGroups: readonly (readonly AgentRole[])[];
  notation: string;
}>;

export type ProviderRuleChoiceV1 = Readonly<{
  label: string;
  rule: CentralProviderRuleV1;
}>;

export class CentralRoleProviderDefaultError extends TypeError {
  readonly code = 'CENTRAL_ROLE_PROVIDER_DEFAULT_INVALID';

  constructor() {
    super('Central role/provider default is invalid.');
    this.name = 'CentralRoleProviderDefaultError';
  }
}

export function centralRoleProviderDefaultDigest(
  value: CentralRoleProviderDefaultBodyV1,
): string {
  const body = assertBody(value);
  return sha256(
    `workflow.central-role-provider-default.v1\n${canonicalJson(body)}`,
  );
}

export function createCentralRoleProviderDefault(
  value: CentralRoleProviderDefaultBodyV1,
): CentralRoleProviderDefaultV1 {
  const body = assertBody(value);
  return deepFreeze({
    ...body,
    configurationDigest: centralRoleProviderDefaultDigest(body),
  });
}

export function renderCentralRoleProviderDefault(
  value: CentralRoleProviderDefaultV1,
): string {
  const configuration = assertConfiguration(value);
  return `${JSON.stringify(configuration, null, 2)}\n`;
}

export function parseCentralRoleProviderDefault(
  source: string,
): CentralRoleProviderDefaultV1 {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidDefault();
  }
  const configuration = assertConfiguration(value);
  if (source !== renderCentralRoleProviderDefault(configuration)) {
    throw invalidDefault();
  }
  return configuration;
}

/**
 * Bind one canonical central default to an exact commit/blob identity. The
 * runtime pinned reader remains responsible for proving tree membership.
 */
export function createCentralRoleProviderDefaultSnapshotV1(
  value: Readonly<{
    pinnedCommit: string;
    blobObjectId: string;
    configuration: CentralRoleProviderDefaultV1;
  }>,
): CentralRoleProviderDefaultSnapshotV1 {
  return materializeSnapshot(value);
}

/** Validate the snapshot bytes; repository membership requires the verifier port. */
export function assertCentralRoleProviderDefaultSnapshotV1(
  value: unknown,
): CentralRoleProviderDefaultSnapshotV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'pinnedCommit',
      'artifactPath',
      'blobObjectId',
      'sourceDigest',
      'configuration',
      'snapshotDigest',
    ]) ||
    typeof value.pinnedCommit !== 'string' ||
    typeof value.blobObjectId !== 'string' ||
    !isRecord(value.configuration)
  ) {
    throw invalidDefault();
  }
  const expected = materializeSnapshot({
    pinnedCommit: value.pinnedCommit,
    blobObjectId: value.blobObjectId,
    configuration: value.configuration as CentralRoleProviderDefaultV1,
  });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw invalidDefault();
  }
  return expected;
}

export function providerPartitionChoices(): readonly ProviderPartitionChoiceV1[] {
  return deepFreeze(
    PROVIDER_PARTITIONS.map((groups, index) => ({
      option: (index + 1) as 1 | 2 | 3 | 4 | 5,
      groups: clonePartition(groups),
      notation: renderProviderPartition(groups),
    })),
  );
}

export function sessionPartitionChoices(
  roles: readonly AgentRole[],
): readonly SessionPartitionChoiceV1[] {
  const admittedRoles = assertCanonicalRoles(roles);
  if (admittedRoles.length === 1) return deepFreeze([]);
  const partitions = partitionsForRoles(admittedRoles);
  return deepFreeze(
    partitions.map((sessionGroups, index) => ({
      option: (index + 1) as 1 | 2 | 3 | 4 | 5,
      sessionGroups: clonePartition(sessionGroups),
      notation: renderSessionPartition(sessionGroups),
    })),
  );
}

export function providerRuleChoices(
  roles: readonly AgentRole[],
  registeredLogicalProviderIds: readonly string[],
): readonly ProviderRuleChoiceV1[] {
  const admittedRoles = assertCanonicalRoles(roles);
  const providerIds = assertRanking(registeredLogicalProviderIds);
  const choices: ProviderRuleChoiceV1[] = admittedRoles.includes('author')
    ? [
        {
          label: 'Adaptive — use the current caller for each change',
          rule: { kind: 'adaptive-author' },
        },
      ]
    : [
        {
          label: 'No preference — use provider ranking',
          rule: {
            kind: 'ranked-fallback',
            preferredLogicalProviderId: null,
          },
        },
      ];
  for (const logicalProviderId of providerIds) {
    choices.push({
      label: `Prefer ${logicalProviderId}`,
      rule: {
        kind: 'ranked-fallback',
        preferredLogicalProviderId: logicalProviderId,
      },
    });
  }
  return deepFreeze(choices);
}

export function renderCentralRoleProviderDefaultSummary(
  value: CentralRoleProviderDefaultV1,
): string {
  const configuration = assertConfiguration(value);
  const lines = [
    'Role configuration',
    '',
    'Role topology',
    `  ${configuration.providerGroups.map(renderProviderGroup).join(' | ')}`,
    '',
    'Provider rules',
  ];
  for (const group of configuration.providerGroups) {
    const label = renderProviderGroup(group);
    const rule =
      group.providerRule.kind === 'adaptive-author'
        ? 'Adaptive (current caller per change)'
        : group.providerRule.preferredLogicalProviderId === null
          ? 'No preference; use provider ranking'
          : `Prefer ${group.providerRule.preferredLogicalProviderId}; fallback by ranking`;
    lines.push(`  ${label} : ${rule}`);
  }
  lines.push('', 'Provider ranking');
  configuration.globalProviderRanking.forEach((logicalProviderId, index) => {
    lines.push(`  ${index + 1}. ${logicalProviderId}`);
  });
  return `${lines.join('\n')}\n`;
}

function assertConfiguration(value: unknown): CentralRoleProviderDefaultV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'configurationDigest',
      'globalProviderRanking',
      'kind',
      'providerGroups',
      'schemaVersion',
    ]) ||
    typeof value.configurationDigest !== 'string' ||
    !DIGEST.test(value.configurationDigest)
  ) {
    throw invalidDefault();
  }
  const body = assertBody({
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    providerGroups: value.providerGroups,
    globalProviderRanking: value.globalProviderRanking,
  });
  const expectedDigest = centralRoleProviderDefaultDigest(body);
  if (value.configurationDigest !== expectedDigest) throw invalidDefault();
  return deepFreeze({ ...body, configurationDigest: expectedDigest });
}

function assertBody(value: unknown): CentralRoleProviderDefaultBodyV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'globalProviderRanking',
      'kind',
      'providerGroups',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'central-role-provider-default' ||
    !Array.isArray(value.providerGroups)
  ) {
    throw invalidDefault();
  }
  const globalProviderRanking = assertRanking(value.globalProviderRanking);
  const providerGroups = value.providerGroups.map((group) =>
    assertProviderGroup(group, globalProviderRanking),
  );
  assertExactPartition(
    providerGroups.map(({ roles }) => roles),
    ROLE_ORDER,
  );
  return deepFreeze({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups,
    globalProviderRanking,
  });
}

function assertProviderGroup(
  value: unknown,
  globalProviderRanking: readonly string[],
): CentralProviderGroupRuleV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['providerRule', 'roles', 'sessionGroups']) ||
    !Array.isArray(value.sessionGroups)
  ) {
    throw invalidDefault();
  }
  const roles = assertCanonicalRoles(value.roles);
  const sessionGroups = value.sessionGroups.map(assertCanonicalRoles);
  assertExactPartition(sessionGroups, roles);
  if (
    roles.length === 1 &&
    canonicalJson(sessionGroups) !== canonicalJson([roles])
  ) {
    throw invalidDefault();
  }
  const providerRule = assertProviderRule(
    value.providerRule,
    roles,
    globalProviderRanking,
  );
  return deepFreeze({ roles, sessionGroups, providerRule });
}

function assertProviderRule(
  value: unknown,
  roles: readonly AgentRole[],
  globalProviderRanking: readonly string[],
): CentralProviderRuleV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw invalidDefault();
  }
  if (value.kind === 'adaptive-author') {
    if (!hasExactKeys(value, ['kind']) || !roles.includes('author')) {
      throw invalidDefault();
    }
    return deepFreeze({ kind: 'adaptive-author' });
  }
  if (
    value.kind !== 'ranked-fallback' ||
    !hasExactKeys(value, ['kind', 'preferredLogicalProviderId']) ||
    (value.preferredLogicalProviderId !== null &&
      (typeof value.preferredLogicalProviderId !== 'string' ||
        !globalProviderRanking.includes(value.preferredLogicalProviderId)))
  ) {
    throw invalidDefault();
  }
  return deepFreeze({
    kind: 'ranked-fallback',
    preferredLogicalProviderId: value.preferredLogicalProviderId,
  });
}

function assertRanking(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    value.some(
      (logicalProviderId) =>
        typeof logicalProviderId !== 'string' ||
        !LOGICAL_PROVIDER_ID.test(logicalProviderId),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw invalidDefault();
  }
  return deepFreeze([...value]) as readonly string[];
}

function assertCanonicalRoles(value: unknown): readonly AgentRole[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ROLE_ORDER.length ||
    value.some((role) => !ROLE_ORDER.includes(role as AgentRole)) ||
    new Set(value).size !== value.length
  ) {
    throw invalidDefault();
  }
  const roles = value as AgentRole[];
  const ordered = [...roles].sort(
    (left, right) => ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right),
  );
  if (canonicalJson(roles) !== canonicalJson(ordered)) throw invalidDefault();
  return deepFreeze([...roles]);
}

function assertExactPartition(
  groups: readonly (readonly AgentRole[])[],
  expectedRoles: readonly AgentRole[],
): void {
  if (groups.length === 0) throw invalidDefault();
  const flattened = groups.flat();
  const orderedUnion = [...flattened].sort(
    (left, right) => ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right),
  );
  const groupOrder = groups.map((roles) =>
    Math.min(...roles.map((role) => ROLE_ORDER.indexOf(role))),
  );
  if (
    canonicalJson(orderedUnion) !== canonicalJson(expectedRoles) ||
    new Set(flattened).size !== expectedRoles.length ||
    groupOrder.some(
      (position, index) => index > 0 && position <= groupOrder[index - 1]!,
    )
  ) {
    throw invalidDefault();
  }
}

function clonePartition(
  groups: readonly (readonly AgentRole[])[],
): readonly (readonly AgentRole[])[] {
  return groups.map((roles) => [...roles]);
}

function partitionsForRoles(
  roles: readonly AgentRole[],
): readonly (readonly (readonly AgentRole[])[])[] {
  if (roles.length === 2) {
    const [left, right] = roles;
    return [[[left!], [right!]], [[left!, right!]]];
  }
  const [first, second, third] = roles;
  return [
    [[first!], [second!], [third!]],
    [[first!, second!], [third!]],
    [[first!], [second!, third!]],
    [[first!, third!], [second!]],
    [[first!, second!, third!]],
  ];
}

function renderProviderPartition(
  groups: readonly (readonly AgentRole[])[],
): string {
  return groups.map((roles) => roles.join(' ')).join(' | ');
}

function renderSessionPartition(
  groups: readonly (readonly AgentRole[])[],
): string {
  return groups.map((roles) => roles.join(' ')).join(' / ');
}

function renderProviderGroup(group: CentralProviderGroupRuleV1): string {
  return group.sessionGroups
    .map((roles) => roles.map(titleRole).join(' '))
    .join(' / ');
}

function titleRole(role: AgentRole): string {
  return `${role[0]!.toUpperCase()}${role.slice(1)}`;
}

function materializeSnapshot(
  value: Readonly<{
    pinnedCommit: string;
    blobObjectId: string;
    configuration: CentralRoleProviderDefaultV1;
  }>,
): CentralRoleProviderDefaultSnapshotV1 {
  if (!FULL_OBJECT_ID.test(value.pinnedCommit)) {
    throw invalidDefault();
  }
  const configuration = assertConfiguration(value.configuration);
  const source = renderCentralRoleProviderDefault(configuration);
  const objectFormat = value.pinnedCommit.length === 40 ? 'sha1' : 'sha256';
  const blobObjectId = crypto
    .createHash(objectFormat)
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
  if (value.blobObjectId !== blobObjectId) {
    throw invalidDefault();
  }
  const body: Omit<CentralRoleProviderDefaultSnapshotV1, 'snapshotDigest'> = {
    schemaVersion: 1,
    kind: 'central-role-provider-default-snapshot.v1',
    pinnedCommit: value.pinnedCommit,
    artifactPath: CENTRAL_ROLE_PROVIDER_DEFAULT_PATH,
    blobObjectId,
    sourceDigest: sha256(source),
    configuration,
  };
  return deepFreeze({
    ...body,
    snapshotDigest: sha256(
      `workflow.central-role-provider-default-snapshot.v1\n${canonicalJson(body)}`,
    ),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function invalidDefault(): CentralRoleProviderDefaultError {
  return new CentralRoleProviderDefaultError();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
