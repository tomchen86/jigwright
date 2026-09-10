/**
 * Loads an independent consumer profile and derives its planning provider,
 * document index and branch.
 *
 * Invariants:
 * - Planning evaluation must match the profile root and schema and
 *   explicitly request read-only access.
 */
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  planningProviderResultDigest,
  type PlanningProviderChangeResult,
  type PlanningProviderExecutionContext,
  type PlanningProviderPort,
} from '@jigwright/core/planning-provider-port';
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';

const PROFILE_PATH = 'tooling/portability-profile.json';
const MAX_PROFILE_BYTES = 32 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type PortabilityFixtureProfileV1 = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright.portability-fixture-profile.v1';
  repositoryName: string;
  protectedBase: string;
  branchTemplate: string;
  planningSchema: string;
  planningRootTemplate: string;
  documentAdapter: string;
  requiredDocuments: readonly string[];
  requiredChecks: readonly string[];
}>;

export function loadPortabilityFixtureProfile(
  requestedRepositoryRoot: string,
): PortabilityFixtureProfileV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const profilePath = path.join(repositoryRoot, PROFILE_PATH);
  const stats = fs.lstatSync(profilePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    stats.size < 1 ||
    stats.size > MAX_PROFILE_BYTES ||
    fs.realpathSync(profilePath) !== profilePath
  ) {
    throw profileInvalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as unknown;
  } catch {
    throw profileInvalid();
  }
  return parseProfile(value);
}

export function createPortabilityFixturePlanningProviderV1(
  requestedRepositoryRoot: string,
  rawProfile: PortabilityFixtureProfileV1,
): PlanningProviderPort {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const profile = parseProfile(rawProfile);
  const installationDigest = planningProviderResultDigest('installation', {
    providerId: 'fixture-plan',
    adapterContractVersion: 1,
    profile,
  });
  const inspect = (
    context: PlanningProviderExecutionContext,
  ): PlanningProviderChangeResult => {
    assertContext(repositoryRoot, profile, context);
    const diagnostics = profile.requiredDocuments.flatMap((document) => {
      const documentPath = path.join(
        repositoryRoot,
        ...context.planningRoot.split('/'),
        document,
      );
      const stats = fs.lstatSync(documentPath, { throwIfNoEntry: false });
      if (
        !stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        stats.size < 1 ||
        stats.size > MAX_DOCUMENT_BYTES ||
        fs.realpathSync(documentPath) !== documentPath
      ) {
        return [
          Object.freeze({
            level: 'ERROR' as const,
            path: `${context.planningRoot}/${document}`,
            message: 'Required fixture planning document is unavailable.',
          }),
        ];
      }
      return [];
    });
    const resultPayload = {
      contractName: context.contractName,
      planningRoot: context.planningRoot,
      revision: context.revision,
      documents: profile.requiredDocuments,
      diagnostics,
    };
    return Object.freeze({
      readiness:
        diagnostics.length === 0 ? ('ready' as const) : ('blocked' as const),
      blockers:
        diagnostics.length === 0
          ? Object.freeze([])
          : Object.freeze([
              Object.freeze({
                artifactId: 'fixture-documents',
                status: 'missing',
                missingDependencies: Object.freeze(
                  diagnostics.map(({ path: missingPath }) => missingPath),
                ),
              }),
            ]),
      valid: diagnostics.length === 0,
      diagnostics: Object.freeze(diagnostics),
      validationDigest: planningProviderResultDigest(
        'validation',
        resultPayload,
      ),
    });
  };
  return Object.freeze({
    id: 'fixture-plan',
    contractVersion: 1,
    inspectInstallation(context: PlanningProviderExecutionContext) {
      assertContext(repositoryRoot, profile, context);
      return Object.freeze({
        providerId: 'fixture-plan',
        adapterContractVersion: 1,
        providerVersion: '1.0.0',
        installationDigest,
      });
    },
    validateChange: inspect,
    inspectChange: inspect,
  });
}

export function renderPortabilityFixtureDocumentIndex(
  profile: PortabilityFixtureProfileV1,
  changeId: string,
): string {
  profile = parseProfile(profile);
  const branch = resolvePortabilityFixtureBranch(profile, changeId);
  return [
    `# ${profile.repositoryName} planning index`,
    '',
    `Schema: \`${profile.planningSchema}\``,
    `Adapter: \`${profile.documentAdapter}\``,
    `Change: \`${changeId}\``,
    `Branch: \`${branch}\``,
    `Protected base: \`${profile.protectedBase}\``,
    '',
    ...profile.requiredDocuments.map((document) => `- \`${document}\``),
    '',
  ].join('\n');
}

export function resolvePortabilityFixtureBranch(
  rawProfile: PortabilityFixtureProfileV1,
  changeId: string,
): string {
  const profile = parseProfile(rawProfile);
  if (!CHANGE_ID.test(changeId)) throw profileInvalid();
  return profile.branchTemplate.replace('{changeId}', changeId);
}

function assertContext(
  repositoryRoot: string,
  profile: PortabilityFixtureProfileV1,
  context: PlanningProviderExecutionContext,
): void {
  if (
    context.repositoryRoot !== repositoryRoot ||
    context.readOnly !== true ||
    !CHANGE_ID.test(context.changeId) ||
    !isSupportedRevision(context.revision) ||
    context.contractName !== profile.planningSchema ||
    context.planningRoot !==
      profile.planningRootTemplate.replace('{changeId}', context.changeId)
  ) {
    throw profileInvalid();
  }
}

function parseProfile(value: unknown): PortabilityFixtureProfileV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'branchTemplate',
      'documentAdapter',
      'kind',
      'planningRootTemplate',
      'planningSchema',
      'protectedBase',
      'repositoryName',
      'requiredChecks',
      'requiredDocuments',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright.portability-fixture-profile.v1' ||
    typeof value.repositoryName !== 'string' ||
    !SAFE_ID.test(value.repositoryName) ||
    typeof value.protectedBase !== 'string' ||
    !SAFE_ID.test(value.protectedBase) ||
    typeof value.branchTemplate !== 'string' ||
    value.branchTemplate !== 'changes/{changeId}' ||
    typeof value.planningSchema !== 'string' ||
    !SAFE_ID.test(value.planningSchema) ||
    typeof value.planningRootTemplate !== 'string' ||
    value.planningRootTemplate !== 'plans/{changeId}' ||
    typeof value.documentAdapter !== 'string' ||
    !SAFE_ID.test(value.documentAdapter) ||
    !isUniqueSafePaths(value.requiredDocuments) ||
    !isUniqueIds(value.requiredChecks)
  ) {
    throw profileInvalid();
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'jigwright.portability-fixture-profile.v1',
    repositoryName: value.repositoryName,
    protectedBase: value.protectedBase,
    branchTemplate: value.branchTemplate,
    planningSchema: value.planningSchema,
    planningRootTemplate: value.planningRootTemplate,
    documentAdapter: value.documentAdapter,
    requiredDocuments: [...value.requiredDocuments].sort(compareText),
    requiredChecks: [...value.requiredChecks].sort(compareText),
  });
}

function isSupportedRevision(
  value: PlanningProviderExecutionContext['revision'],
): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'worktree') return hasExactKeys(value, ['kind']);
  return (
    value.kind === 'commit' &&
    hasExactKeys(value, ['kind', 'objectId']) &&
    typeof value.objectId === 'string' &&
    /^[0-9a-f]{40,64}$/u.test(value.objectId)
  );
}

function isUniqueSafePaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    return false;
  }
  try {
    return (
      value.every(
        (entry) =>
          typeof entry === 'string' &&
          normalizeExactRepositoryPath(entry) === entry &&
          !entry.includes('/'),
      ) && new Set(value).size === value.length
    );
  } catch {
    return false;
  }
}

function isUniqueIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 16 &&
    value.every((entry) => typeof entry === 'string' && SAFE_ID.test(entry)) &&
    new Set(value).size === value.length
  );
}

function deepFreeze(
  profile: PortabilityFixtureProfileV1,
): PortabilityFixtureProfileV1 {
  return Object.freeze({
    ...profile,
    requiredDocuments: Object.freeze([...profile.requiredDocuments]),
    requiredChecks: Object.freeze([...profile.requiredChecks]),
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileInvalid(): TypeError {
  return new TypeError('Portability fixture profile is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return canonicalJson(actual) === canonicalJson(required);
}
