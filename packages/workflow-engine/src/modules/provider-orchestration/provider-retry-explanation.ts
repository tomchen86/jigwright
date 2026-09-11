/**
 * Preserves the agent's failure assessment and next action with a retry.
 *
 * Invariants:
 * - Explanations describe intent; they do not grant authority or prove recovery.
 * - Unknown causes and unchanged execution settings remain valid explanations.
 */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type ProviderRetryExplanation = Readonly<{
  failureReason: string;
  plannedAction: string;
}>;

export function parseProviderRetryExplanation(
  value: unknown,
): ProviderRetryExplanation {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'failureReason,plannedAction'
  ) {
    throw invalidExplanation();
  }
  const input = value as Record<string, unknown>;
  for (const name of ['failureReason', 'plannedAction']) {
    const text = input[name];
    if (
      typeof text !== 'string' ||
      text.trim().length === 0 ||
      text.length > 4_000
    ) {
      throw invalidExplanation();
    }
  }
  return Object.freeze({
    failureReason: input.failureReason as string,
    plannedAction: input.plannedAction as string,
  });
}

export function defaultProviderRetryExplanation(
  failure: { code: string; message: string } | null,
): ProviderRetryExplanation {
  return {
    failureReason:
      failure === null
        ? 'The prior attempt failed; the cause is not established.'
        : `${failure.code}: ${failure.message}`.slice(0, 4_000),
    plannedAction:
      'Retry the same work under the recorded execution policy and applicable repair context.',
  };
}

function invalidExplanation() {
  return workflowError(
    'PROVIDER_RETRY_EXPLANATION_INVALID',
    'A retry needs a nonempty failure assessment and planned action, each at most 4000 characters.',
    ExitCode.usage,
  );
}
