import fs from 'node:fs';
import path from 'node:path';

import { renderHandoff } from '../adapters/consumer/expense-app/handoff/handoff.ts';
import { repositoryHandoffRelativePath } from '../adapters/consumer/expense-app/work-registry/contracts.ts';
import {
  assertOrdinaryWorkRegistryTransition,
  closeLegacyIssueCompatibilityAlias,
  createWorkItem,
  renderWorkRegistry,
  updateLegacyIssueCompatibilityAlias,
  validateWorkRegistry,
  validateWorkRegistryProjections,
  type WorkItemAuthoringV1,
} from '../modules/governance-intake/work-registry.ts';
import {
  repositoryConsumerPath,
  repositoryWorkRegistryConfiguration,
} from '../modules/repository-consumer/repository-consumer-config.ts';

export function renderGovernanceIntakeHandoff(repositoryRoot: string): string {
  renderHandoff(repositoryRoot);
  return repositoryHandoffRelativePath(repositoryRoot);
}

export function legacyIssueBacklogRelativePath(repositoryRoot: string): string {
  return repositoryWorkRegistryConfiguration(repositoryRoot).backlogPath;
}

export function createLegacyIssueCompatibilityWorkItem(
  repositoryRoot: string,
  input: WorkItemAuthoringV1,
  alias: string,
) {
  return createWorkItem(repositoryRoot, input, { aliases: [alias] });
}

export function updateLegacyIssueCompatibilityWorkItem(
  repositoryRoot: string,
  alias: string,
  field: 'title' | 'status' | 'priority' | 'notes',
  value: string,
) {
  return updateLegacyIssueCompatibilityAlias(
    repositoryRoot,
    alias,
    field,
    value,
  );
}

export function closeLegacyIssueCompatibilityWorkItem(
  repositoryRoot: string,
  alias: string,
  date: string,
  notes: string,
) {
  return closeLegacyIssueCompatibilityAlias(repositoryRoot, alias, date, notes);
}

export function assertOrdinaryLegacyIssueCompatibilityTransition(
  repositoryRoot: string,
  transition: 'intake' | 'prioritize',
  recovery: string,
): void {
  assertOrdinaryWorkRegistryTransition(repositoryRoot, transition, recovery);
}

export function renderLegacyIssueCompatibilityProjections(
  repositoryRoot: string,
) {
  const rendered = renderWorkRegistry(repositoryRoot);
  if (hasWorkflowConfig(repositoryRoot)) renderHandoff(repositoryRoot);
  return rendered;
}

export function validateLegacyIssueCompatibilityRegistry(
  repositoryRoot: string,
): void {
  validateWorkRegistry(repositoryRoot);
  validateWorkRegistryProjections(repositoryRoot);
}

export function workRegistryIsActivated(repositoryRoot: string): boolean {
  return fs.existsSync(
    repositoryConsumerPath(
      repositoryRoot,
      repositoryWorkRegistryConfiguration(repositoryRoot).itemRoot,
    ),
  );
}

function hasWorkflowConfig(repositoryRoot: string): boolean {
  return fs.existsSync(path.join(repositoryRoot, 'workflow', 'config.json'));
}
