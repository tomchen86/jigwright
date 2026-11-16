/**
 * Lists the exact budget exceptions for one provider replacement.
 *
 * Invariants:
 * - Limits come from the durable Job; reservations come from the execution policy.
 * - The failed-attempt snapshot fixes the calculation across request, approval and replay.
 * - An exception covers one next attempt and never rewrites default policy.
 */
import { executionRetryBudgetChanges } from '../../modules/provider-orchestration/execution-retry.ts';
import type { ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type { ExecutionJobInspection } from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { LoadedAiAdapterPolicy } from '../../runtime/provider-policy/ai-adapter-policy.ts';

export function executionReplacementBudgetChanges(
  inspection: ExecutionJobInspection,
  timeoutMs: number,
  policy: LoadedAiAdapterPolicy,
) {
  const attempt = inspection.attempts.at(-1)!;
  const reservation =
    policy.policy.retryAccounting.reservations[attempt.provider as ProviderId];
  return executionRetryBudgetChanges({
    job: inspection.job,
    attempt,
    failure: attempt.failure!,
    providerAttemptCount: inspection.attempts.filter(
      ({ provider }) => provider === attempt.provider,
    ).length,
    nextRuntimeMs: timeoutMs,
    nextProviderCostMicros: reservation.providerCostMicros,
    nextProviderTokens: reservation.providerTokens,
    now: attempt.updatedAt,
  });
}
