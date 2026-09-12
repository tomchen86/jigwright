/** Runs resolved checks in order with pinned runners and per-check checkout freshness. */
import type { CheckRegistryPortV1 } from '@jigwright/core/check-registry-port';
import type { CheckEvidence } from '../../foundation/check-evidence/check-evidence.ts';
import type {
  CheckExecutionPort,
  CheckPostValidation,
} from '../../modules/assurance/check-execution-port.ts';
import { resolveRequiredCiChecks } from '../../modules/assurance/required-checks.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export function runRequiredChecks(
  repositoryRoot: string,
  head: string,
  checkIds: string[],
  registry: CheckRegistryPortV1,
  execution: CheckExecutionPort,
  postValidation: CheckPostValidation,
): CheckEvidence[] {
  const required = resolveRequiredCiChecks(repositoryRoot, checkIds, registry);
  const databaseIdentity = required.some(
    ({ definition }) => definition.destructiveDatabase,
  )
    ? execution.preflightDatabase()
    : undefined;
  const pinned = required.map((check) => ({
    checkId: check.checkId,
    execute: execution.pin(
      check,
      check.definition.destructiveDatabase ? databaseIdentity : undefined,
    ),
  }));
  const initial = execution.observe(head);
  const evidence: CheckEvidence[] = [];
  for (const { checkId, execute } of pinned) {
    evidence.push(execute());
    const current = execution.observe(head);
    if (
      current.head !== head ||
      current.statusEntryCount > 0 ||
      current.fingerprint !== initial.fingerprint
    ) {
      throw workflowError(
        'CI_CHECK_MUTATED_WORKTREE',
        `Required CI check ${checkId} changed the checkout.`,
        ExitCode.staleState,
        { details: { checkId } },
      );
    }
  }
  execution.validate(postValidation, head);
  return evidence;
}

export type RegisteredCheckRepository = Readonly<{
  repositoryRoot: string;
  head: string;
  statusEntryCount: number;
}>;

export type RegisteredCheckResult = { head: string; check: CheckEvidence };

export function runRegisteredCheck(
  repository: RegisteredCheckRepository,
  checkId: string,
  registry: CheckRegistryPortV1,
  execution: CheckExecutionPort,
): RegisteredCheckResult {
  if (repository.statusEntryCount > 0) {
    throw workflowError(
      'STANDALONE_CHECK_DIRTY_WORKTREE',
      'Standalone registered checks require a clean checkout.',
      ExitCode.staleState,
      {
        details: { statusEntryCount: repository.statusEntryCount },
        recovery:
          'Commit or remove controlled checkout changes before running the registered check.',
      },
    );
  }
  const checks = registry.load(repository.repositoryRoot).checks;
  if (!Object.hasOwn(checks, checkId)) {
    throw workflowError(
      'CI_CHECK_UNKNOWN',
      `Check registry does not contain ${checkId}.`,
      ExitCode.guard,
      { details: { checkId } },
    );
  }
  if (checks[checkId]!.destructiveDatabase) {
    throw workflowError(
      'STANDALONE_DESTRUCTIVE_CHECK',
      `Standalone execution refuses destructive check ${checkId}.`,
      ExitCode.unsafeEnvironment,
      {
        details: { checkId },
        recovery:
          'Run destructive checks only through an authorized managed task with explicit disposable database evidence.',
      },
    );
  }
  const evidence = runRequiredChecks(
    repository.repositoryRoot,
    repository.head,
    [checkId],
    registry,
    execution,
    'live-current-ref',
  );
  return { head: repository.head, check: evidence[0]! };
}
