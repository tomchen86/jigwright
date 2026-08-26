import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import type {
  RepositoryConsumerConfigurationV1,
  RepositoryConsumerPortV1,
  RepositoryDatabasePolicyConfigurationV1,
  RepositoryDocumentConfigurationV1,
  RepositoryPlanningConfigurationV1,
  RepositoryWorkRegistryConfigurationV1,
} from '@jigwright/core/repository-consumer-port';
import {
  RepositoryPathError,
  normalizeExactRepositoryPath,
} from '@jigwright/core/repository-path';
import { assertPolicyPathInsideRepository } from '@jigwright/core/runtime-path-kernel';

import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  workflowError,
  type ExitCodeValue,
} from '../../foundation/errors/errors.ts';

const CONFIG_PATH = 'workflow/repository-consumer.json';
const WORKFLOW_CONFIG_PATH = 'workflow/config.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_SCHEMA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type LoadedRepositoryConsumerConfiguration = Readonly<{
  configuration: RepositoryConsumerConfigurationV1;
  source: 'tracked';
}>;

export const productionRepositoryConsumerPort: RepositoryConsumerPortV1 =
  Object.freeze({
    contractVersion: 'jigwright.repository-consumer-port.v1' as const,
    load(repositoryRoot: string): RepositoryConsumerConfigurationV1 {
      return loadRepositoryConsumerConfiguration(repositoryRoot).configuration;
    },
  });

export function loadRepositoryConsumerConfiguration(
  requestedRepositoryRoot: string,
): LoadedRepositoryConsumerConfiguration {
  const repositoryRoot = canonicalRoot(requestedRepositoryRoot);
  const configPath = path.join(repositoryRoot, CONFIG_PATH);
  const stats = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw configError(
      'REPOSITORY_CONSUMER_CONFIG_MISSING',
      'The repository must provide workflow/repository-consumer.json.',
      ExitCode.guard,
    );
  }
  const value = readBoundedJson(configPath, stats);
  const configuration = parseRepositoryConsumerConfiguration(value);
  if (configuration.consumerId !== readRepositoryName(repositoryRoot)) {
    throw configInvalid();
  }
  assertConfiguredPathsInsideRepository(repositoryRoot, configuration);
  return Object.freeze({
    configuration,
    source: 'tracked' as const,
  });
}

export function repositoryDocumentConfiguration(
  repositoryRoot: string,
): RepositoryDocumentConfigurationV1 {
  return productionRepositoryConsumerPort.load(repositoryRoot).documents;
}

export function repositoryPlanningConfiguration(
  repositoryRoot: string,
): RepositoryPlanningConfigurationV1 {
  return productionRepositoryConsumerPort.load(repositoryRoot).planning;
}

export function repositoryWorkRegistryConfiguration(
  repositoryRoot: string,
): RepositoryWorkRegistryConfigurationV1 {
  return productionRepositoryConsumerPort.load(repositoryRoot).workRegistry;
}

export function repositoryDatabasePolicyConfiguration(
  repositoryRoot: string,
): RepositoryDatabasePolicyConfigurationV1 {
  return productionRepositoryConsumerPort.load(repositoryRoot).databasePolicy;
}

export function repositoryConsumerPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  productionRepositoryConsumerPort.load(repositoryRoot);
  return resolveCanonicalRepositoryPath(
    canonicalRoot(repositoryRoot),
    safePath(relativePath),
  );
}

export function parseRepositoryConsumerConfiguration(
  value: unknown,
): RepositoryConsumerConfigurationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'adapterId',
      'consumerId',
      'databasePolicy',
      'documents',
      'planning',
      'schemaVersion',
      'workRegistry',
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
    !hasExactKeys(value.documents, [
      'adapterId',
      'handoffPath',
      'issueLogPath',
      'issueSourcePath',
    ]) ||
    typeof value.documents.adapterId !== 'string' ||
    !isRecord(value.workRegistry) ||
    !hasExactKeys(value.workRegistry, [
      'adapterId',
      'backlogPath',
      'changeOriginRoot',
      'historyRoot',
      'inventoryPath',
      'itemRoot',
      'sourceRoot',
      'transitionPolicyPath',
    ]) ||
    typeof value.workRegistry.adapterId !== 'string' ||
    !isRecord(value.databasePolicy) ||
    !hasExactKeys(value.databasePolicy, ['adapterId']) ||
    typeof value.databasePolicy.adapterId !== 'string'
  ) {
    throw configInvalid();
  }
  if (
    value.planning.providerId !== 'openspec' ||
    value.documents.adapterId !== 'filesystem-documents-v1' ||
    value.workRegistry.adapterId !== 'filesystem-work-registry-v1' ||
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
    throw configInvalid();
  }
  const documents = value.documents as Record<string, unknown>;
  const workRegistry = value.workRegistry as Record<string, unknown>;
  const documentPaths = [
    documents.handoffPath,
    documents.issueSourcePath,
    documents.issueLogPath,
  ].map(safePathValue);
  const registryPaths = [
    workRegistry.itemRoot,
    workRegistry.inventoryPath,
    workRegistry.backlogPath,
    workRegistry.historyRoot,
    workRegistry.sourceRoot,
    workRegistry.transitionPolicyPath,
    workRegistry.changeOriginRoot,
  ].map(safePathValue);
  if (
    new Set(documentPaths).size !== documentPaths.length ||
    new Set(registryPaths).size !== registryPaths.length ||
    new Set([...documentPaths, ...registryPaths]).size !==
      documentPaths.length + registryPaths.length
  ) {
    throw configInvalid();
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
      issueSourcePath: documentPaths[1]!,
      issueLogPath: documentPaths[2]!,
    },
    workRegistry: {
      adapterId: 'filesystem-work-registry-v1',
      itemRoot: registryPaths[0]!,
      inventoryPath: registryPaths[1]!,
      backlogPath: registryPaths[2]!,
      historyRoot: registryPaths[3]!,
      sourceRoot: registryPaths[4]!,
      transitionPolicyPath: registryPaths[5]!,
      changeOriginRoot: registryPaths[6]!,
    },
    databasePolicy: { adapterId: value.databasePolicy.adapterId },
  });
}

function assertConfiguredPathsInsideRepository(
  repositoryRoot: string,
  configuration: RepositoryConsumerConfigurationV1,
): void {
  const paths = [
    configuration.documents.handoffPath,
    configuration.documents.issueSourcePath,
    configuration.documents.issueLogPath,
    configuration.workRegistry.itemRoot,
    configuration.workRegistry.inventoryPath,
    configuration.workRegistry.backlogPath,
    configuration.workRegistry.historyRoot,
    configuration.workRegistry.sourceRoot,
    configuration.workRegistry.transitionPolicyPath,
    configuration.workRegistry.changeOriginRoot,
  ];
  try {
    for (const configuredPath of paths) {
      assertPolicyPathInsideRepository(repositoryRoot, configuredPath);
      resolveCanonicalRepositoryPath(repositoryRoot, configuredPath);
    }
  } catch {
    throw configInvalid();
  }
}

function resolveCanonicalRepositoryPath(
  repositoryRoot: string,
  configuredPath: string,
): string {
  let current = repositoryRoot;
  const segments = configuredPath.split('/');
  for (const [index, segment] of segments.entries()) {
    const candidate = path.join(current, segment);
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stats === undefined) {
      return path.join(current, ...segments.slice(index));
    }
    if (
      stats.isSymbolicLink() ||
      (index < segments.length - 1 && !stats.isDirectory()) ||
      (index === segments.length - 1 && !stats.isDirectory() && !stats.isFile())
    ) {
      throw new Error('unsafe configured path topology');
    }
    const canonical = fs.realpathSync(candidate);
    assertCanonicalContainment(repositoryRoot, canonical);
    current = canonical;
  }
  return current;
}

function assertCanonicalContainment(
  repositoryRoot: string,
  candidate: string,
): void {
  const relative = path.relative(repositoryRoot, candidate);
  if (
    relative === '' ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error('configured path escapes repository');
  }
}

function readRepositoryName(repositoryRoot: string): string {
  const configPath = path.join(repositoryRoot, WORKFLOW_CONFIG_PATH);
  const stats = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (stats === undefined) throw configInvalid();
  const value = readBoundedJson(configPath, stats);
  if (
    !isRecord(value) ||
    typeof value.repositoryName !== 'string' ||
    !SAFE_ID.test(value.repositoryName)
  ) {
    throw configInvalid();
  }
  return value.repositoryName;
}

function readBoundedJson(filePath: string, stats: fs.Stats): unknown {
  try {
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size < 1 ||
      stats.size > MAX_CONFIG_BYTES ||
      fs.realpathSync(filePath) !== filePath
    ) {
      throw new Error('unsafe configuration file');
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.byteLength !== stats.size) throw new Error('configuration drift');
    return JSON.parse(UTF8.decode(bytes)) as unknown;
  } catch {
    throw configInvalid();
  }
}

function canonicalRoot(requestedRepositoryRoot: string): string {
  try {
    const resolved = path.resolve(requestedRepositoryRoot);
    const canonical = fs.realpathSync(resolved);
    if (!fs.statSync(canonical).isDirectory()) {
      throw new Error('unsafe repository root');
    }
    return canonical;
  } catch {
    throw configInvalid();
  }
}

function safePathValue(value: unknown): string {
  if (typeof value !== 'string') throw configInvalid();
  return safePath(value);
}

function safePath(value: string): string {
  try {
    if (normalizeExactRepositoryPath(value) !== value) throw configInvalid();
    return value;
  } catch (error) {
    if (error instanceof RepositoryPathError) throw configInvalid();
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

function configInvalid(): ReturnType<typeof workflowError> {
  return configError(
    'REPOSITORY_CONSUMER_CONFIG_INVALID',
    'Repository consumer configuration does not match schema version 1.',
    ExitCode.verification,
  );
}

function configError(code: string, message: string, exitCode: ExitCodeValue) {
  return workflowError(code, message, exitCode);
}
