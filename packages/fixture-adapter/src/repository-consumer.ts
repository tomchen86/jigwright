/**
 * Builds fixture repository configuration from a supplied consumer profile.
 *
 * Invariants:
 * - The loader returns its frozen configuration only for the same canonical
 *   repository root.
 */
import fs from 'node:fs';

import type {
  RepositoryConsumerConfigurationV1,
  RepositoryConsumerPortV1,
} from '@jigwright/core/repository-consumer-port';

type FixtureRepositoryProfileV1 = Readonly<{
  repositoryName: string;
  planningSchema: string;
  documentAdapter: string;
}>;

/** A second implementation of the public repository-consumer port. */
export function createFixtureRepositoryConsumerPortV1(
  requestedRepositoryRoot: string,
  profile: FixtureRepositoryProfileV1,
): RepositoryConsumerPortV1 {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const configuration = fixtureConfiguration(profile);
  return Object.freeze({
    contractVersion: 'jigwright.repository-consumer-port.v1' as const,
    load(requestedRoot: string): RepositoryConsumerConfigurationV1 {
      if (fs.realpathSync(requestedRoot) !== repositoryRoot) {
        throw new TypeError('Fixture repository consumer root is invalid.');
      }
      return configuration;
    },
  });
}

function fixtureConfiguration(
  profile: FixtureRepositoryProfileV1,
): RepositoryConsumerConfigurationV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    adapterId: 'configured-repository-v1',
    consumerId: profile.repositoryName,
    planning: Object.freeze({
      providerId: 'fixture-plan',
      packageSchemaNames: Object.freeze([]),
      requiredSchemaNames: Object.freeze([profile.planningSchema]),
      supportedSchemaNames: Object.freeze([profile.planningSchema]),
      managedSchemaNames: Object.freeze([profile.planningSchema]),
      currentSchemaName: profile.planningSchema,
    }),
    documents: Object.freeze({
      adapterId: profile.documentAdapter,
      handoffPath: 'notebook/handoff.md',
    }),
    workRegistry: Object.freeze({
      adapterId: 'fixture-work-registry-v1',
      itemRoot: 'state/work/items',
      inventoryPath: 'state/work/inventory.json',
      backlogPath: 'notebook/backlog.md',
      historyRoot: 'notebook/history',
      transitionPolicyPath: 'state/work/policy.json',
      changeOriginRoot: 'plans',
    }),
    databasePolicy: Object.freeze({ adapterId: 'disabled-v1' }),
  });
}
