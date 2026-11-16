/** Binds shared check execution to production runners, database policy and repository validation. */
import type { CheckRegistryPortV1 } from '@jigwright/core/check-registry-port';
import {
  runRequiredChecks,
  runRegisteredCheck as runRegisteredCheckUseCase,
} from '../application/assurance/check-execution.ts';
import type { CheckRepositoryValidation } from '../modules/assurance/check-execution-port.ts';
import { createCheckExecution } from '../adapters/consumer/repository/work-registry/check-runner.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
} from '../runtime/repository-transaction/git.ts';
import {
  validateRepositoryState,
  validateRepositoryStateAtCommit,
} from './repository-validation.ts';
import { productionCheckRegistryPort } from './check-registry-production.ts';

export const createProductionCheckExecution = createCheckExecution;

function productionCheckValidation(
  repositoryRoot: string,
): CheckRepositoryValidation {
  return {
    observe(head) {
      const current = discoverRepository(repositoryRoot);
      return {
        head: current.head,
        statusEntryCount: current.statusEntries.length,
        fingerprint: fingerprintWorkingState(
          repositoryRoot,
          head,
          current.statusEntries,
        ),
      };
    },
    validate(mode, head) {
      if (mode === 'immutable-head')
        validateRepositoryStateAtCommit(repositoryRoot, head);
      else validateRepositoryState(repositoryRoot);
    },
  };
}

export function runCiChecksAtCommit(
  repositoryRoot: string,
  head: string,
  checkIds: string[],
  environment: NodeJS.ProcessEnv,
  registry: CheckRegistryPortV1 = productionCheckRegistryPort,
) {
  return runRequiredChecks(
    repositoryRoot,
    head,
    checkIds,
    registry,
    createProductionCheckExecution(repositoryRoot, environment),
    productionCheckValidation(repositoryRoot),
    'immutable-head',
  );
}

export function runRegisteredCheck(
  cwd: string,
  checkId: string,
  environment: NodeJS.ProcessEnv,
) {
  const repository = discoverRepository(cwd);
  return runRegisteredCheckUseCase(
    {
      repositoryRoot: repository.repositoryRoot,
      head: repository.head,
      statusEntryCount: repository.statusEntries.length,
    },
    checkId,
    productionCheckRegistryPort,
    createProductionCheckExecution(repository.repositoryRoot, environment),
    productionCheckValidation(repository.repositoryRoot),
  );
}
