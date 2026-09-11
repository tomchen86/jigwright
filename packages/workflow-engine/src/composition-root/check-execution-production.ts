/** Binds shared check execution to production runners, database policy and repository validation. */
import type { CheckRegistryPortV1 } from '@jigwright/core/check-registry-port';
import {
  runRequiredChecks,
  runRegisteredCheck as runRegisteredCheckUseCase,
} from '../application/assurance/check-execution.ts';
import type { CheckExecutionPort } from '../modules/assurance/check-execution-port.ts';
import {
  pinCheckRunner,
  runCheck,
} from '../adapters/consumer/repository/work-registry/check-runner.ts';
import {
  assertDisposableDatabaseForRepository,
  createCheckEnvironmentForRepository,
} from '../adapters/consumer/repository/work-registry/database-policy.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
} from '../runtime/repository-transaction/git.ts';
import {
  validateRepositoryState,
  validateRepositoryStateAtCommit,
} from './repository-validation.ts';
import { productionCheckRegistryPort } from './check-registry-production.ts';

function productionCheckExecution(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): CheckExecutionPort {
  return {
    preflightDatabase() {
      return assertDisposableDatabaseForRepository(repositoryRoot, environment)
        .identity;
    },
    pin({ checkId, definition }, databaseIdentity) {
      const runner = pinCheckRunner(repositoryRoot, checkId, definition);
      return () =>
        runCheck(
          repositoryRoot,
          checkId,
          definition,
          runner,
          createCheckEnvironmentForRepository(
            repositoryRoot,
            environment,
            definition.destructiveDatabase,
          ),
          databaseIdentity,
        );
    },
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
    productionCheckExecution(repositoryRoot, environment),
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
    productionCheckExecution(repository.repositoryRoot, environment),
  );
}
