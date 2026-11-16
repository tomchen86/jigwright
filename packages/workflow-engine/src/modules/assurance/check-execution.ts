/** Prepare the whole selected batch before execution; consumers own post-check observation. */
import type {
  CheckEvidence,
  ObservedCheckOutcome,
} from '../../foundation/check-evidence/check-evidence.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { CheckExecutionPort } from './check-execution-port.ts';
import type { ResolvedRequiredCheck } from './required-checks.ts';

export function prepareCheckBatch(
  required: readonly ResolvedRequiredCheck[],
  execution: CheckExecutionPort,
) {
  const databaseIdentity = required.some(
    ({ definition }) => definition.destructiveDatabase,
  )
    ? execution.preflightDatabase()
    : undefined;
  return required.map((check) => ({
    checkId: check.checkId,
    execution: execution.pin(
      check,
      check.definition.destructiveDatabase ? databaseIdentity : undefined,
    ),
  }));
}

export function requirePassedCheck(
  checkId: string,
  outcome: ObservedCheckOutcome,
): CheckEvidence {
  if (outcome.outcome === 'failed') {
    throw workflowError(
      'CHECK_FAILED',
      `Required check ${checkId} exited non-zero.`,
      ExitCode.verification,
      { details: { checkId, exitCode: outcome.exitCode, signal: null } },
    );
  }
  return outcome;
}
