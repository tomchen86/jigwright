/** Binds registry query and projection use cases without importing the write hub. */
import fs from 'node:fs';
import { createWorkRegistryQueries } from '../application/work-registry/work-registry-queries.ts';
import { createWorkRegistryProjectionOperations } from '../application/work-registry/work-registry-projections.ts';
import { createWorkRegistryStorage } from '../runtime/work-registry/storage.ts';
import { createWorkRegistryPromotionLocks } from '../runtime/work-registry/transactions.ts';
import {
  listOriginPaths,
  readOrigin,
  originChangeId,
  relativeOriginPath,
  createCurrentOriginReader,
} from '../runtime/work-registry/origin-observation.ts';
import { createWorkRegistryProjectionStorage } from '../runtime/work-registry/projection-storage.ts';
import { repositoryConsumerConfigurationExists } from '../runtime/workflow-configuration/repository-consumer.ts';
import {
  readGovernanceSource,
  listGovernanceSources,
} from './governance-sources-production.ts';

const locks = createWorkRegistryPromotionLocks();
const storage = createWorkRegistryStorage(locks);
export const workRegistryQueries = createWorkRegistryQueries({
  ...locks,
  readItems: (root) =>
    storage.listWorkItemPaths(root).map(storage.readWorkItem),
  readItemsUnlocked: (root) =>
    storage.listWorkItemPathsUnlocked(root).map(storage.readWorkItem),
  readSource: readGovernanceSource,
  listSources: listGovernanceSources,
  canonicalRoot: (root) => fs.realpathSync(root),
  hasConsumerConfiguration: repositoryConsumerConfigurationExists,
  listOriginReferences: listOriginPaths,
  readOrigin,
  originChangeId,
  relativeOriginPath,
  readCurrentOrigin: createCurrentOriginReader(storage.readOptionalPlainFile),
});
export const workRegistryProjectionOperations =
  createWorkRegistryProjectionOperations(
    workRegistryQueries,
    createWorkRegistryProjectionStorage(storage.readOptionalPlainFile),
    locks.withWorkRegistryPromotionLockWhenAvailable,
    (root, id) => readGovernanceSource(root, id).text,
  );
