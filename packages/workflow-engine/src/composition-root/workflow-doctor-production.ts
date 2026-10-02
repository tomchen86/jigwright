/** Binds repository diagnostics to existing observers without eager repository access. */
import { existsSync } from 'node:fs';
import { createWorkflowDoctor } from '../application/assurance/workflow-doctor.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { loadWorkflowConfig } from '../runtime/workflow-configuration/workflow-configuration.ts';
import { diagnoseOpenSpec } from '../adapters/planning/openspec/documents/openspec-doctor.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';
import { inspectRepositorySystemDocuments } from '../runtime/managed-documents/validation/system-documents.ts';
import { inspectProjectionStatus } from './projection-status-production.ts';
import { listSessions } from '../runtime/repository-observation/workflow-session-context.ts';

export const diagnoseWorkflowRepository = createWorkflowDoctor({
  discoverRepository,
  loadWorkflowConfig,
  diagnoseOpenSpec,
  readSystemDescriptionSnapshot,
  inspectRepositorySystemDocuments,
  existsPath: existsSync,
  inspectProjectionStatus,
  listSessions,
});
