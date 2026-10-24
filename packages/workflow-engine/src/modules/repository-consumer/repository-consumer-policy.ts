/** Validates consumer policy values without observing repository files or adapters. */
import {
  GOVERNANCE_SOURCE_LEDGER_ROOT,
  type RepositoryConsumerConfigurationV1,
  type RepositoryWorkRegistryConfigurationV1,
} from '@jigwright/core/repository-consumer-port';
import {
  RepositoryPathError,
  normalizeExactRepositoryPath,
} from '@jigwright/core/repository-path';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  workflowError,
  type ExitCodeValue,
} from '../../foundation/errors/errors.ts';

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_SCHEMA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DEFAULT_WORK_REGISTRY_CONFIGURATION: RepositoryWorkRegistryConfigurationV1 =
  Object.freeze({
    adapterId: 'filesystem-work-registry-v1',
    itemRoot: 'docs/work-registry/items',
    inventoryPath: 'docs/work-registry/inventory.json',
    backlogPath: 'docs/BACKLOG.md',
    historyRoot: 'docs/work-history',
    transitionPolicyPath: 'workflow/work-registry-policy.json',
    changeOriginRoot: 'openspec/changes',
  });

export function isRepositoryConsumerId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value);
}

export function parseRepositoryConsumerConfiguration(
  value: unknown,
): RepositoryConsumerConfigurationV1 {
  if (!isRecord(value)) throw invalidRepositoryConsumerConfiguration();
  const hasExplicitWorkRegistry = Object.hasOwn(value, 'workRegistry');
  if (
    !hasExactKeys(value, [
      'adapterId',
      'consumerId',
      'databasePolicy',
      'documents',
      'planning',
      'schemaVersion',
      ...(hasExplicitWorkRegistry ? ['workRegistry'] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    value.adapterId !== 'configured-repository-v1' ||
    typeof value.consumerId !== 'string' ||
    !SAFE_ID.test(value.consumerId) ||
    !isRecord(value.planning) ||
    !hasExactKeys(value.planning, [
      'currentSchemaName',
      'managedSchemaNames',
      'packageSchemaNames',
      'providerId',
      'requiredSchemaNames',
      'supportedSchemaNames',
    ]) ||
    typeof value.planning.providerId !== 'string' ||
    !SAFE_ID.test(value.planning.providerId) ||
    !isSchemaNames(value.planning.packageSchemaNames, true) ||
    !isSchemaNames(value.planning.requiredSchemaNames, false) ||
    !isSchemaNames(value.planning.supportedSchemaNames, false) ||
    !isSchemaNames(value.planning.managedSchemaNames, false) ||
    typeof value.planning.currentSchemaName !== 'string' ||
    !SAFE_SCHEMA_NAME.test(value.planning.currentSchemaName) ||
    !isRecord(value.documents) ||
    !hasExactKeys(value.documents, ['adapterId', 'handoffPath']) ||
    typeof value.documents.adapterId !== 'string' ||
    !isRecord(value.databasePolicy) ||
    !hasExactKeys(value.databasePolicy, ['adapterId']) ||
    typeof value.databasePolicy.adapterId !== 'string'
  ) {
    throw invalidRepositoryConsumerConfiguration();
  }
  if (hasExplicitWorkRegistry && value.workRegistry === null) {
    throw workRegistryDisabledInvalid();
  }
  const workRegistry = hasExplicitWorkRegistry
    ? value.workRegistry
    : DEFAULT_WORK_REGISTRY_CONFIGURATION;
  if (!isWorkRegistryConfiguration(workRegistry))
    throw invalidRepositoryConsumerConfiguration();
  if (
    value.planning.providerId !== 'openspec' ||
    value.documents.adapterId !== 'filesystem-documents-v1' ||
    workRegistry.adapterId !== 'filesystem-work-registry-v1' ||
    !['postgresql-disposable-v1', 'disabled-v1'].includes(
      value.databasePolicy.adapterId,
    )
  ) {
    throw configError(
      'REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED',
      'Repository consumer configuration selects an unsupported code-owned adapter.',
      ExitCode.guard,
    );
  }
  const planning = value.planning;
  const supported = new Set(planning.supportedSchemaNames as string[]);
  const packageNames = new Set(planning.packageSchemaNames as string[]);
  const managedNames = new Set(planning.managedSchemaNames as string[]);
  if (
    !supported.has(planning.currentSchemaName as string) ||
    !managedNames.has(planning.currentSchemaName as string) ||
    [...(planning.requiredSchemaNames as string[])].some(
      (name) => !supported.has(name),
    ) ||
    [...packageNames].some((name) => !supported.has(name)) ||
    [...managedNames].some(
      (name) => !supported.has(name) || packageNames.has(name),
    ) ||
    packageNames.size + managedNames.size !== supported.size
  ) {
    throw invalidRepositoryConsumerConfiguration();
  }
  const documents = value.documents as Record<string, unknown>;
  const documentPaths = [documents.handoffPath].map(safePathValue);
  const registryPaths = [
    workRegistry.itemRoot,
    workRegistry.inventoryPath,
    workRegistry.backlogPath,
    workRegistry.historyRoot,
    workRegistry.transitionPolicyPath,
    workRegistry.changeOriginRoot,
  ].map(safePathValue);
  const managedPaths = [
    ...documentPaths,
    GOVERNANCE_SOURCE_LEDGER_ROOT,
    ...registryPaths,
  ];
  if (
    new Set(documentPaths).size !== documentPaths.length ||
    new Set(registryPaths).size !== registryPaths.length ||
    new Set(managedPaths).size !== managedPaths.length
  ) {
    throw invalidRepositoryConsumerConfiguration();
  }
  return deepFreeze({
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId: value.consumerId,
    planning: {
      providerId: planning.providerId as string,
      packageSchemaNames: [...(planning.packageSchemaNames as string[])],
      requiredSchemaNames: [...(planning.requiredSchemaNames as string[])],
      supportedSchemaNames: [...(planning.supportedSchemaNames as string[])],
      managedSchemaNames: [...(planning.managedSchemaNames as string[])],
      currentSchemaName: planning.currentSchemaName as string,
    },
    documents: {
      adapterId: 'filesystem-documents-v1',
      handoffPath: documentPaths[0]!,
    },
    workRegistry: {
      adapterId: 'filesystem-work-registry-v1',
      itemRoot: registryPaths[0]!,
      inventoryPath: registryPaths[1]!,
      backlogPath: registryPaths[2]!,
      historyRoot: registryPaths[3]!,
      transitionPolicyPath: registryPaths[4]!,
      changeOriginRoot: registryPaths[5]!,
    },
    databasePolicy: { adapterId: value.databasePolicy.adapterId },
  });
}

function safePathValue(value: unknown): string {
  if (typeof value !== 'string') throw invalidRepositoryConsumerConfiguration();
  return validatedRepositoryConsumerPath(value);
}

export function validatedRepositoryConsumerPath(value: string): string {
  try {
    if (normalizeExactRepositoryPath(value) !== value)
      throw invalidRepositoryConsumerConfiguration();
    return value;
  } catch (error) {
    if (error instanceof RepositoryPathError)
      throw invalidRepositoryConsumerConfiguration();
    throw error;
  }
}

function isSchemaNames(value: unknown, allowEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.length <= 32 &&
    value.every(
      (entry) => typeof entry === 'string' && SAFE_SCHEMA_NAME.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

function isWorkRegistryConfiguration(
  value: unknown,
): value is RepositoryWorkRegistryConfigurationV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'adapterId',
      'backlogPath',
      'changeOriginRoot',
      'historyRoot',
      'inventoryPath',
      'itemRoot',
      'transitionPolicyPath',
    ]) &&
    typeof value.adapterId === 'string'
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function deepFreeze<T extends RepositoryConsumerConfigurationV1>(value: T): T {
  Object.freeze(value.planning.packageSchemaNames);
  Object.freeze(value.planning.requiredSchemaNames);
  Object.freeze(value.planning.supportedSchemaNames);
  Object.freeze(value.planning.managedSchemaNames);
  Object.freeze(value.planning);
  Object.freeze(value.documents);
  Object.freeze(value.workRegistry);
  Object.freeze(value.databasePolicy);
  return Object.freeze(value);
}

export function invalidRepositoryConsumerConfiguration(): ReturnType<
  typeof workflowError
> {
  return configError(
    'REPOSITORY_CONSUMER_CONFIG_INVALID',
    'Repository consumer configuration does not match schema version 1.',
    ExitCode.verification,
  );
}

function workRegistryDisabledInvalid(): ReturnType<typeof workflowError> {
  return configError(
    'REPOSITORY_CONSUMER_CONFIG_INVALID',
    'D-018 keeps the Work Registry built in; workRegistry: null is invalid.',
    ExitCode.verification,
  );
}

function configError(code: string, message: string, exitCode: ExitCodeValue) {
  return workflowError(code, message, exitCode);
}
