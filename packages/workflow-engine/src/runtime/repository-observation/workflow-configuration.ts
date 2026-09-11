/** Read workflow/check configuration and apply repository path admission. */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { invalidContract } from '../../modules/planning-provider/change-contract-errors.ts';
import type { ManagedSchemaName } from '../../modules/planning-provider/change-contract.ts';
import {
  parseWorkflowConfig,
  type WorkflowConfig,
} from '../../modules/repository-consumer/workflow-config.ts';
import {
  parseChecksConfigSource,
  type ChecksConfig,
} from '../../modules/source/check-command.ts';
import { assertPolicyPathInsideRepository } from '../session-workspace/paths.ts';
import { relative } from './contract-artifact-observation.ts';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerPath,
} from './repository-consumer.ts';

export function repositoryCurrentSchemaName(
  repositoryRoot: string,
): ManagedSchemaName {
  return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
    .planning.currentSchemaName;
}

export function repositoryPlanningPolicy(repositoryRoot: string) {
  return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
    .planning;
}

export function repositoryHandoffPath(repositoryRoot: string): string {
  return repositoryConsumerPath(
    repositoryRoot,
    repositoryHandoffRelativePath(repositoryRoot),
  );
}

export function repositoryHandoffRelativePath(repositoryRoot: string): string {
  return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
    .documents.handoffPath;
}

export function loadWorkflowConfig(repositoryRoot: string): WorkflowConfig {
  const configPath = path.join(repositoryRoot, 'workflow/config.json');
  const configuration = parseWorkflowConfig(
    readJson(configPath, 'workflow configuration'),
    configPath,
  );
  if (configuration.taskAuthorization !== undefined) {
    assertPolicyPathInsideRepository(
      repositoryRoot,
      configuration.taskAuthorization.pathRoleRegistry,
    );
  }
  return configuration;
}

export function loadChecksConfig(repositoryRoot: string): ChecksConfig {
  const checksPath = path.join(repositoryRoot, 'workflow/checks.json');
  const value = readJson(checksPath, 'check configuration');
  const parsed = parseChecksConfigSource(value);
  if (!parsed.ok && parsed.reason === 'invalid-registry') {
    throw invalidContract(
      'INVALID_CHECKS_CONFIG',
      'workflow/checks.json does not match schema version 1.',
      checksPath,
    );
  }
  if (!parsed.ok) {
    throw invalidContract(
      'INVALID_CHECK_DEFINITION',
      `Invalid check definition: ${parsed.checkId}`,
      checksPath,
    );
  }
  return parsed.value;
}

export function readJson(filePath: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw workflowError(
      'UNREADABLE_CONTRACT',
      `Unable to read ${label}: ${relative(process.cwd(), filePath)}`,
      ExitCode.unsafeEnvironment,
      {
        details: {
          filePath,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}
