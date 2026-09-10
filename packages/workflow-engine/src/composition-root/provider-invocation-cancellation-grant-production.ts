/**
 * Connects cancellation Grants to durable provider requests, terminal
 * observations and worker fence handling.
 *
 * Invariants:
 * - Cancellation observations reject changes to the invocation request or
 *   input manifest bound by the Grant.
 */
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  assertProviderInvocationCancellationObservation,
  assertProviderInvocationCancellationParameters,
  type ProviderInvocationCancellationGrantPort,
  type ProviderInvocationCancellationObservationV1,
  type ProviderInvocationCancellationParametersV1,
} from '../modules/authority/provider-invocation-cancellation-grant.ts';
import {
  PROVIDER_COMPLETION_GRACE_MS,
  claimProviderInvocationForWorkerUnderLifecycleLock,
  createProviderInvocationCancellationBinding,
  failProviderInvocationUnderLifecycleLock,
  publishProviderInvocationCancellationRequestFromPreparedGrant,
  readProviderInvocation,
  readProviderInvocationCancellationRequest,
  readProviderInvocationRequest,
  releaseProviderInvocationWorkerFenceUnderLifecycleLock,
} from '../runtime/storage-journal/provider-invocation-store.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';

const CANCELLATION_POLL_INTERVAL_MS = 25;

export function createProductionProviderInvocationCancellationGrantPort(
  cwd: string,
): ProviderInvocationCancellationGrantPort {
  const context = loadInvestigationRuntimeContext(cwd);
  return Object.freeze({
    observe(parameters: ProviderInvocationCancellationParametersV1) {
      return observeCurrentProviderInvocationCancellation(
        context.runtime,
        parameters,
      );
    },
    async cancel(authorized) {
      const parameters = assertProviderInvocationCancellationParameters(
        authorized.parameters,
      );
      authorized.assertLifecycleOwned();
      publishProviderInvocationCancellationRequestFromPreparedGrant(
        context.runtime,
        parameters.binding.invocationId,
        {
          challengeId: authorized.challengeId,
          operationId: authorized.operationId,
        },
      );
      authorized.assertLifecycleOwned();

      let observation = observeCurrentProviderInvocationCancellation(
        context.runtime,
        parameters,
      );
      if (
        observation.phase === 'cancellation-requested' &&
        parameters.binding.expectedState === 'prepared'
      ) {
        observation = failPreparedInvocationBeforeLaunch(
          context.runtime,
          parameters,
          authorized.operationId,
          authorized.assertLifecycleOwned,
        );
      }
      if (observation.phase === 'terminal' && !observation.workerFencePresent) {
        return observation;
      }

      const request = readProviderInvocationRequest(
        context.runtime,
        parameters.binding.invocationId,
      );
      const deadline =
        Date.now() + request.limits.timeoutMs + PROVIDER_COMPLETION_GRACE_MS;
      while (Date.now() <= deadline) {
        authorized.assertLifecycleOwned();
        observation = observeCurrentProviderInvocationCancellation(
          context.runtime,
          parameters,
        );
        if (
          observation.phase === 'terminal' &&
          !observation.workerFencePresent
        ) {
          return observation;
        }
        await delay(CANCELLATION_POLL_INTERVAL_MS);
      }
      authorized.assertLifecycleOwned();
      return observeCurrentProviderInvocationCancellation(
        context.runtime,
        parameters,
      );
    },
  });
}

export function observeCurrentProviderInvocationCancellationRequest(
  cwd: string,
  invocationId: string,
  reason: string,
): ProviderInvocationCancellationObservationV1 {
  const context = loadInvestigationRuntimeContext(cwd);
  const binding = createProviderInvocationCancellationBinding(
    context.runtime,
    invocationId,
  );
  const request = readProviderInvocationRequest(context.runtime, invocationId);
  if (
    readProviderInvocationCancellationRequest(context.runtime, invocationId) !==
    null
  ) {
    throw cancellationStateChanged(
      'Provider invocation already has a durable cancellation request.',
    );
  }
  return assertProviderInvocationCancellationObservation({
    schemaVersion: 1,
    kind: 'provider-invocation-cancellation-observation.v1',
    phase: 'active',
    repositoryId: request.repositoryId,
    binding,
    reason,
    cancellationRequestDigest: null,
    terminal: null,
    workerFencePresent: binding.workerFenceDigest !== null,
  });
}

function observeCurrentProviderInvocationCancellation(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  candidate: ProviderInvocationCancellationParametersV1,
): ProviderInvocationCancellationObservationV1 {
  const parameters = assertProviderInvocationCancellationParameters(candidate);
  const invocationId = parameters.binding.invocationId;
  const record = readProviderInvocation(runtime, invocationId);
  const request = readProviderInvocationRequest(runtime, invocationId);
  if (
    request.repositoryId !== parameters.repositoryId ||
    record.requestDigest !== parameters.binding.requestDigest ||
    record.manifestDigest !== parameters.binding.manifestDigest
  ) {
    throw cancellationStateChanged(
      'Provider invocation identity changed after Grant creation.',
    );
  }

  const cancellation = readProviderInvocationCancellationRequest(
    runtime,
    invocationId,
  );
  if (
    cancellation !== null &&
    (cancellation.reason !== parameters.reason ||
      canonicalJson(cancellation.binding) !== canonicalJson(parameters.binding))
  ) {
    throw cancellationStateChanged(
      'Provider cancellation request does not match the exact Grant.',
    );
  }

  const workerFencePresent = fs.existsSync(
    path.join(runtime.locks, `${invocationId}.worker-active`),
  );
  if (record.state === 'succeeded' || record.state === 'failed') {
    assertTerminalLineage(record, parameters);
    return assertProviderInvocationCancellationObservation({
      schemaVersion: 1,
      kind: 'provider-invocation-cancellation-observation.v1',
      phase: 'terminal',
      repositoryId: parameters.repositoryId,
      binding: parameters.binding,
      reason: parameters.reason,
      cancellationRequestDigest: cancellation?.requestDigest ?? null,
      terminal: {
        state: record.state,
        revision: record.revision,
        failureCode:
          record.state === 'succeeded' ? null : (record.failure?.code ?? null),
      },
      workerFencePresent,
    });
  }

  const currentBinding = createProviderInvocationCancellationBinding(
    runtime,
    invocationId,
  );
  if (canonicalJson(currentBinding) !== canonicalJson(parameters.binding)) {
    throw cancellationStateChanged(
      'Provider invocation changed before exact cancellation completed.',
    );
  }
  return assertProviderInvocationCancellationObservation({
    schemaVersion: 1,
    kind: 'provider-invocation-cancellation-observation.v1',
    phase: cancellation === null ? 'active' : 'cancellation-requested',
    repositoryId: parameters.repositoryId,
    binding: parameters.binding,
    reason: parameters.reason,
    cancellationRequestDigest: cancellation?.requestDigest ?? null,
    terminal: null,
    workerFencePresent,
  });
}

function failPreparedInvocationBeforeLaunch(
  runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  parameters: ProviderInvocationCancellationParametersV1,
  operationId: string,
  assertLifecycleOwned: () => void,
): ProviderInvocationCancellationObservationV1 {
  const invocationId = parameters.binding.invocationId;
  const request = readProviderInvocationRequest(runtime, invocationId);
  let claim:
    | ReturnType<typeof claimProviderInvocationForWorkerUnderLifecycleLock>
    | undefined;
  try {
    claim = claimProviderInvocationForWorkerUnderLifecycleLock(
      runtime,
      invocationId,
      {
        workerId: `grant-cancellation-${operationId}`,
        leaseDurationMs: Math.max(1, Math.min(1_000, request.limits.timeoutMs)),
        expectedRevision: parameters.binding.expectedRevision,
      },
      assertLifecycleOwned,
    );
  } catch (error) {
    const raced = observeCurrentProviderInvocationCancellation(
      runtime,
      parameters,
    );
    if (raced.phase !== 'terminal') throw error;
    return raced;
  }

  assertLifecycleOwned();
  failProviderInvocationUnderLifecycleLock(
    runtime,
    invocationId,
    {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code: 'PROVIDER_INVOCATION_CANCELLED_BEFORE_LAUNCH',
        message: parameters.reason,
      },
    },
    assertLifecycleOwned,
  );
  assertLifecycleOwned();
  releaseProviderInvocationWorkerFenceUnderLifecycleLock(
    runtime,
    invocationId,
    claim.workerFenceToken,
    assertLifecycleOwned,
  );
  assertLifecycleOwned();
  return observeCurrentProviderInvocationCancellation(runtime, parameters);
}

function assertTerminalLineage(
  record: ReturnType<typeof readProviderInvocation>,
  parameters: ProviderInvocationCancellationParametersV1,
): void {
  const binding = parameters.binding;
  const expectedLeaseGeneration =
    binding.expectedState === 'prepared'
      ? binding.leaseGeneration + 1
      : binding.leaseGeneration;
  if (
    record.revision <= binding.expectedRevision ||
    record.leaseGeneration !== expectedLeaseGeneration ||
    (record.state === 'failed' && record.failure === null)
  ) {
    throw cancellationStateChanged(
      'Provider invocation reached a terminal state outside the exact cancellation lineage.',
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cancellationStateChanged(message: string) {
  return workflowError(
    'PROVIDER_INVOCATION_CANCELLATION_STATE_CHANGED',
    message,
    ExitCode.staleState,
  );
}
