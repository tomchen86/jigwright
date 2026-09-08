import { createOpenSpecAdapter } from './openspec-adapter-production.ts';
import {
  createOpenSpecPlanningProviderPortV1,
  OpenSpecAdapterError,
} from '@jigwright/openspec-adapter/planning-provider';

import type {
  PlanningProviderExecutionContext,
  PlanningProviderPort,
} from '../modules/planning-provider/planning-provider-port.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { resolveOpenSpecInstallation } from '../adapters/planning/openspec/documents/openspec-adapter.ts';
import {
  OPENSPEC_PACKAGE_NAME,
  OPENSPEC_PACKAGE_VERSION,
} from '../adapters/planning/openspec/documents/openspec-provenance.ts';
import type { RepositoryPlanningConfigurationV1 } from '@jigwright/core/repository-consumer-port';

/**
 * Thin production composition facade. The native OpenSpec process/parser
 * remains injected here while provider evidence mapping is package-owned.
 */
export function createOpenSpecPlanningProviderPort(
  repositoryRoot: string,
  planning: RepositoryPlanningConfigurationV1,
): PlanningProviderPort {
  if (planning.providerId !== 'openspec') {
    throw workflowError(
      'PLANNING_PROVIDER_REPOSITORY_CONFIG_MISMATCH',
      'The repository consumer did not select the OpenSpec planning adapter.',
      ExitCode.guard,
    );
  }
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const extracted = createOpenSpecPlanningProviderPortV1({
    repositoryRoot: installation.repositoryRoot,
    providerRequirement: Object.freeze({
      package: OPENSPEC_PACKAGE_NAME,
      version: OPENSPEC_PACKAGE_VERSION,
    }),
    installation: Object.freeze({
      providerVersion: installation.version,
      lockfileVersion: installation.lockfileVersion,
      lockedVersion: installation.lockedVersion,
      integrity: installation.integrity,
      buildScriptsAllowed: installation.buildScriptsAllowed,
    }),
    requiredSchemaNames: planning.requiredSchemaNames,
    supportedContractNames: planning.supportedSchemaNames,
    native: createOpenSpecAdapter(installation.repositoryRoot, {
      schemaPolicy: {
        packageSchemaNames: planning.packageSchemaNames,
        projectSchemaNames: planning.managedSchemaNames,
        supportedSchemaNames: planning.supportedSchemaNames,
        currentSchemaName: planning.currentSchemaName,
      },
    }),
  });

  return Object.freeze({
    id: extracted.id,
    contractVersion: extracted.contractVersion,
    inspectInstallation(context: PlanningProviderExecutionContext) {
      return mapOpenSpecAdapterError(() =>
        extracted.inspectInstallation(context),
      );
    },
    validateChange(context: PlanningProviderExecutionContext) {
      return mapOpenSpecAdapterError(() => extracted.validateChange(context));
    },
    inspectChange(context: PlanningProviderExecutionContext) {
      return mapOpenSpecAdapterError(() => extracted.inspectChange(context));
    },
  });
}

function mapOpenSpecAdapterError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof OpenSpecAdapterError)) throw error;
    throw workflowError(error.code, error.message, ExitCode.verification, {
      ...(error.details === undefined ? {} : { details: { ...error.details } }),
    });
  }
}
