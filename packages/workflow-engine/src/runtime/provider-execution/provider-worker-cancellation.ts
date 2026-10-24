/** Observe exact durable cancellation for one live worker claim. */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { ProviderWorkerLeaseClaim } from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationCancellationWatcher } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import { readProviderInvocationCancellationRequestForWorkerClaim } from '../storage-journal/provider-invocation-store.ts';

const PROVIDER_CANCELLATION_POLL_INTERVAL_MS = 25;

export function createProviderInvocationCancellationWatcher(
  runtime: InvestigationRuntimePaths,
  invocationId: string,
  claim: ProviderWorkerLeaseClaim,
  externalSignal: AbortSignal | undefined,
): ProviderInvocationCancellationWatcher {
  const control = new AbortController();
  let stopped = false;
  let exactCancellation = false;
  let timer: NodeJS.Timeout | undefined;
  const inspect = (): boolean => {
    if (exactCancellation) return true;
    try {
      const request = readProviderInvocationCancellationRequestForWorkerClaim(
        runtime,
        invocationId,
        {
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          workerFenceToken: claim.workerFenceToken,
        },
      );
      if (request === null) return false;
      exactCancellation = true;
      control.abort();
      return true;
    } catch {
      // A malformed, forged, stale, or differently claimed request has no
      // cancellation authority. Durable storage validation remains responsible
      // for reporting that state; the provider process must keep its own result.
      return false;
    }
  };
  const poll = () => {
    if (stopped || inspect()) return;
    timer = setTimeout(poll, PROVIDER_CANCELLATION_POLL_INTERVAL_MS);
    timer.unref();
  };
  poll();
  return Object.freeze({
    signal:
      externalSignal === undefined
        ? control.signal
        : AbortSignal.any([externalSignal, control.signal]),
    hasExactCancellation: inspect,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  });
}
