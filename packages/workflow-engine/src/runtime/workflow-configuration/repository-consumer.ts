/**
 * Loads consumer configuration and resolves repository-contained policy
 * paths.
 *
 * Invariants:
 * - Consumer identity must match workflow/config.json repositoryName.
 */
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  GOVERNANCE_SOURCE_LEDGER_ROOT,
  type RepositoryConsumerConfigurationV1,
} from '@jigwright/core/repository-consumer-port';
import { assertPolicyPathInsideRepository } from '@jigwright/repository-runtime/paths';

import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

import {
  parseRepositoryConsumerConfiguration,
  invalidRepositoryConsumerConfiguration as configInvalid,
  validatedRepositoryConsumerPath as safePath,
  isRepositoryConsumerId,
} from '../../modules/repository-consumer/repository-consumer-policy.ts';

const CONFIG_PATH = 'workflow/repository-consumer.json';
const WORKFLOW_CONFIG_PATH = 'workflow/config.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
export type LoadedRepositoryConsumerConfiguration = Readonly<{
  configuration: RepositoryConsumerConfigurationV1;
  source: 'tracked';
}>;

export function loadRepositoryConsumerConfiguration(
  requestedRepositoryRoot: string,
): LoadedRepositoryConsumerConfiguration {
  const repositoryRoot = canonicalRoot(requestedRepositoryRoot);
  const configPath = path.join(repositoryRoot, CONFIG_PATH);
  const stats = fs.lstatSync(configPath, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw workflowError(
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

/**
 * Report only whether the repository-consumer configuration file is present.
 * Core Source capture and correction-chain reads may operate before a consumer
 * config exists. A present file must still pass the strict loader.
 */
export function repositoryConsumerConfigurationExists(
  requestedRepositoryRoot: string,
): boolean {
  const repositoryRoot = canonicalRoot(requestedRepositoryRoot);
  return (
    fs.lstatSync(path.join(repositoryRoot, CONFIG_PATH), {
      throwIfNoEntry: false,
    }) !== undefined
  );
}

export function repositoryConsumerPath(
  repositoryRoot: string,
  relativePath: string,
): string {
  loadRepositoryConsumerConfiguration(repositoryRoot);
  return resolveCanonicalRepositoryPath(
    canonicalRoot(repositoryRoot),
    safePath(relativePath),
  );
}

function assertConfiguredPathsInsideRepository(
  repositoryRoot: string,
  configuration: RepositoryConsumerConfigurationV1,
): void {
  const paths = [
    configuration.documents.handoffPath,
    GOVERNANCE_SOURCE_LEDGER_ROOT,
    configuration.workRegistry.itemRoot,
    configuration.workRegistry.inventoryPath,
    configuration.workRegistry.backlogPath,
    configuration.workRegistry.historyRoot,
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
    !isRepositoryConsumerId(value.repositoryName)
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
