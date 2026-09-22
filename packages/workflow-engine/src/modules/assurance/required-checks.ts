/** Resolves required check definitions through the existing versioned registry contract. */
import type {
  CheckDefinitionV1,
  CheckRegistryPortV1,
} from '@jigwright/core/check-registry-port';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type ResolvedRequiredCheck = Readonly<{
  checkId: string;
  definition: CheckDefinitionV1;
}>;

export function resolveRequiredCiChecks(
  repositoryRoot: string,
  checkIds: readonly string[],
  checkRegistryPort: CheckRegistryPortV1,
): ResolvedRequiredCheck[] {
  if (
    !isRecord(checkRegistryPort) ||
    checkRegistryPort.contractVersion !== 'jigwright.check-registry-port.v1' ||
    typeof checkRegistryPort.load !== 'function'
  ) {
    throw workflowError(
      'CI_CHECK_REGISTRY_UNSUPPORTED',
      'CI check selection requires the exact CheckRegistry port contract v1.',
      ExitCode.guard,
    );
  }
  const registry = checkRegistryPort.load(repositoryRoot);
  if (
    !isRecord(registry) ||
    registry.schemaVersion !== 1 ||
    !isRecord(registry.checks)
  ) {
    throw invalidCheckRegistry();
  }
  return checkIds.map((checkId) => {
    if (!Object.hasOwn(registry.checks, checkId)) {
      throw workflowError(
        'CI_CHECK_UNKNOWN',
        `CI task policy references unknown check ${checkId}.`,
        ExitCode.guard,
      );
    }
    const definition = registry.checks[checkId];
    if (
      !isRecord(definition) ||
      !hasExactDefinitionKeys(definition) ||
      !Array.isArray(definition.command) ||
      definition.command.some((part) => typeof part !== 'string') ||
      typeof definition.destructiveDatabase !== 'boolean' ||
      (definition.liveStderr !== undefined &&
        typeof definition.liveStderr !== 'boolean')
    ) {
      throw invalidCheckRegistry();
    }
    const normalized = Object.freeze({
      command: [...definition.command],
      destructiveDatabase: definition.destructiveDatabase,
      ...(definition.liveStderr === undefined
        ? {}
        : { liveStderr: definition.liveStderr }),
    });
    return Object.freeze({ checkId, definition: normalized });
  });
}

function hasExactDefinitionKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return (
    JSON.stringify(keys) ===
      JSON.stringify(['command', 'destructiveDatabase']) ||
    JSON.stringify(keys) ===
      JSON.stringify(['command', 'destructiveDatabase', 'liveStderr'])
  );
}

function invalidCheckRegistry(): ReturnType<typeof workflowError> {
  return workflowError(
    'CI_CHECK_REGISTRY_INVALID',
    'The selected CheckRegistry adapter returned an invalid v1 registry.',
    ExitCode.guard,
  );
}
