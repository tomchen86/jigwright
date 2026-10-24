/**
 * Dispatches prepared provider work and resumes exact failed-survey retries.
 *
 * Invariants:
 * - Any attached mandate agrees with the invocation and its durable session owner.
 * - Retry inputs bind the failed attempt, prior request, session revision, and baseline.
 * - Exact retries reuse the recorded replacement and preserve provider mandate observations.
 */
import { defaultProviderRetryExplanation } from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { createRuntimeId } from './propose-common.ts';
import { sha256 } from '../../modules/proposal/propose-values.ts';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import type { ProposeRuntime } from './propose-runtime.ts';
import { getProposeStatus } from './propose-status.ts';
import type {
  ProposeOutput,
  ProposeProviderDispatcher,
  ProposeResumeOptions,
  ProviderRetryEnvelope,
} from '../../modules/proposal/propose-types.ts';
export function createProviderRetryEnvelope(
  services: Pick<
    ProposeRuntime,
    'taskMandate' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  output: ProposeOutput,
  acknowledgement: { acknowledgeProviderCost: true },
): ProviderRetryEnvelope {
  const status = output.investigation;
  if (
    output.nextAction !== 'retry-provider' ||
    status === null ||
    status.state === 'investigation-exempt' ||
    status.provider.state !== 'failed' ||
    status.provider.failure?.kind !== 'retryable' ||
    acknowledgement.acknowledgeProviderCost !== true
  ) {
    throw workflowError(
      'PROVIDER_RETRY_NOT_AVAILABLE',
      'The propose wrapper has no retryable failed blind-survey invocation.',
      ExitCode.guard,
    );
  }
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const request = services.provider.readProviderInvocationRequest(
    context.runtime,
    status.providerInvocationId,
  );
  const session = services.investigation.readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  if (request.requestDigest !== session.blindRequestDigest) {
    throw workflowError(
      'PROVIDER_RETRY_BINDING_INVALID',
      'The failed provider request no longer matches the investigation.',
      ExitCode.staleState,
    );
  }
  return {
    schemaVersion: 1,
    kind: 'provider-retry',
    investigationId: status.investigationId,
    changeId: status.changeId,
    expectedRevision: status.revision,
    baseline: { ...status.baseline },
    intentDigest: status.intentDigest,
    blindManifestDigest: status.blindManifestDigest,
    failedInvocation: {
      invocationId: status.providerInvocationId,
      attempt: status.provider.attempt,
      revision: status.provider.revision,
      requestDigest: request.requestDigest,
      failureDigest: sha256(canonicalJson(status.provider.failure)),
    },
    acknowledgeProviderCost: true,
  };
}

export function dispatchMandatedProviderInvocation(
  services: Pick<
    ProposeRuntime,
    'taskMandate' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  invocationId: string,
  dispatch: (
    runtime: ReturnType<
      ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
    >['runtime'],
    request: ProviderInvocationRequest,
  ) => void,
): void {
  const initialContext =
    services.workspace.loadInvestigationRuntimeContext(cwd);
  const initial = services.provider.readProviderInvocation(
    initialContext.runtime,
    invocationId,
  );
  const ownerBinding = durableProviderOwnerMandateBinding(
    services,
    initialContext,
    initial.investigationId,
    initial.changeId,
  );
  if (
    canonicalJson(initial.mandateBinding ?? null) !==
    canonicalJson(ownerBinding ?? null)
  ) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'Provider invocation does not match its durable owner mandate binding.',
      ExitCode.staleState,
    );
  }
  if (ownerBinding === undefined) {
    dispatch(
      initialContext.runtime,
      services.provider.readProviderInvocationRequest(
        initialContext.runtime,
        invocationId,
      ),
    );
    return;
  }
  services.taskMandate.withActiveTaskMandateBinding(
    cwd,
    ownerBinding.mandateTaskId,
    {},
    (activeBinding, assertOwned) => {
      if (canonicalJson(activeBinding) !== canonicalJson(ownerBinding)) {
        throw workflowError(
          'TASK_MANDATE_BINDING_STALE',
          'Provider dispatch no longer matches the active Task Mandate.',
          ExitCode.staleState,
        );
      }
      const context = services.workspace.loadInvestigationRuntimeContext(cwd);
      const invocation = services.provider.readProviderInvocation(
        context.runtime,
        invocationId,
      );
      const durableOwnerBinding = durableProviderOwnerMandateBinding(
        services,
        context,
        invocation.investigationId,
        invocation.changeId,
      );
      if (
        invocation.state !== 'prepared' ||
        canonicalJson(invocation.mandateBinding ?? null) !==
          canonicalJson(activeBinding) ||
        canonicalJson(durableOwnerBinding ?? null) !==
          canonicalJson(activeBinding)
      ) {
        throw workflowError(
          'TASK_MANDATE_BINDING_STALE',
          'Provider dispatch lost its exact durable Task Mandate binding.',
          ExitCode.staleState,
        );
      }
      const request = services.provider.readProviderInvocationRequest(
        context.runtime,
        invocationId,
      );
      services.taskMandate.recordTaskMandateProviderInvocationUnderLifecycleLock(
        cwd,
        activeBinding,
        {
          providerId: request.providerId,
          invocationId,
          requestDigest: request.requestDigest,
          occurredAt: invocation.createdAt,
        },
        assertOwned,
      );
      assertOwned();
      dispatch(context.runtime, request);
      assertOwned();
    },
  );
}

function durableProviderOwnerMandateBinding(
  services: Pick<ProposeRuntime, 'taskMandate' | 'investigation'>,
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  investigationId: string,
  changeId: string,
): TaskMandateBinding | undefined {
  const owner = services.investigation.isProposeExemptionInvestigationId(
    investigationId,
  )
    ? services.investigation.readProposeExemptionSession(
        context.runtime,
        investigationId,
      )
    : services.investigation.readInvestigationSession(
        context.runtime,
        investigationId,
      );
  if (owner.changeId !== changeId) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'Provider invocation belongs to another durable change owner.',
      ExitCode.staleState,
    );
  }
  return owner.mandateBinding;
}

export function dispatchPreparedInvocation(
  services: Pick<
    ProposeRuntime,
    'taskMandate' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  status: InvestigationStatus,
  dispatcher: ProposeProviderDispatcher | undefined,
): void {
  if (!dispatcher || status.provider.state !== 'prepared') {
    return;
  }
  dispatchMandatedProviderInvocation(
    services,
    cwd,
    status.providerInvocationId,
    (_runtime, request) => dispatcher(cwd, request.invocationId),
  );
}

export function resumeProviderRetry(
  services: ProposeRuntime,
  cwd: string,
  input: ProviderRetryEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const current = services.investigation.getInvestigationStatus(
    cwd,
    input.investigationId,
  );
  assertProviderRetrySessionBinding(current, input);
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const failed = services.provider.readProviderInvocation(
    context.runtime,
    input.failedInvocation.invocationId,
  );
  const failedRequest = services.provider.readProviderInvocationRequest(
    context.runtime,
    failed.invocationId,
  );
  const currentExecutionPolicy = services.provider.loadAiAdapterPolicy(
    context.git.repositoryRoot,
  );
  assertProviderRetryFailureBinding(input, failed, failedRequest);

  let retried: InvestigationStatus;
  if (current.revision === input.expectedRevision) {
    if (current.providerInvocationId !== failed.invocationId) {
      throw providerRetryInputStale();
    }
    try {
      retried = services.investigation.retryInvestigationProvider(
        cwd,
        current.investigationId,
        {
          expectedRevision: input.expectedRevision,
          replacementRequest:
            options.executionGrantAuthorization?.replacementRequest ??
            createProviderInvocationRequest({
              invocationId: createRuntimeId('invocation'),
              nonce: `provider-retry-${crypto.randomUUID()}`,
              purpose: failedRequest.purpose,
              providerId: failedRequest.providerId,
              roleAssignment: failedRequest.roleAssignment,
              capabilityProfile: failedRequest.capabilityProfile,
              repositoryId: failedRequest.repositoryId,
              baseCommit: failedRequest.baseCommit,
              baseTree: failedRequest.baseTree,
              targetDigest: failedRequest.targetDigest,
              inputManifestDigest: failedRequest.inputManifestDigest,
              authorizationNodeId: failedRequest.authorizationNodeId,
              writeAllowedPaths: [],
              outputSchema: failedRequest.outputSchema,
              evaluatorVersion: failedRequest.evaluatorVersion,
              policyDigest: currentExecutionPolicy.digest,
              retryExplanation:
                input.retryExplanation ??
                defaultProviderRetryExplanation(failed.failure),
              limits: {
                timeoutMs:
                  input.timeoutMs ??
                  currentExecutionPolicy.policy.limits.timeoutMs,
                aggregateOutputBytes:
                  currentExecutionPolicy.policy.limits.aggregateOutputBytes,
              },
            }),
          executionGrantAuthorization: options.executionGrantAuthorization,
        },
      );
    } catch (error) {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'INVESTIGATION_CAS_MISMATCH'
      ) {
        throw error;
      }
      try {
        retried = readExactProviderRetryReplay(services, cwd, input, failed);
      } catch (replayError) {
        if (
          replayError instanceof WorkflowError &&
          replayError.code === 'PROVIDER_RETRY_INPUT_STALE'
        ) {
          throw error;
        }
        throw replayError;
      }
    }
  } else {
    retried = readExactProviderRetryReplay(
      services,
      cwd,
      input,
      failed,
      current,
    );
  }

  dispatchPreparedRetryInvocation(services, cwd, retried, options);
  return getProposeStatus(
    services,
    cwd,
    retried.investigationId,
    options.collaborationGrantValidation,
  );
}

function readExactProviderRetryReplay(
  services: Pick<
    ProposeRuntime,
    'taskMandate' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  input: ProviderRetryEnvelope,
  failed: ReturnType<ProposeRuntime['provider']['readProviderInvocation']>,
  observed?: InvestigationStatus,
): InvestigationStatus {
  const current =
    observed ??
    services.investigation.getInvestigationStatus(cwd, input.investigationId);
  assertProviderRetrySessionBinding(current, input);
  if (current.revision !== input.expectedRevision + 1) {
    throw providerRetryInputStale();
  }
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const reservation = services.provider.readProviderRetryReservation(
    context.runtime,
    current.investigationId,
    failed.attempt + 1,
  );
  const session = services.investigation.readInvestigationSession(
    context.runtime,
    current.investigationId,
  );
  if (
    reservation === null ||
    (input.timeoutMs !== undefined &&
      reservation.request.limits.timeoutMs !== input.timeoutMs) ||
    (input.retryExplanation !== undefined &&
      canonicalJson(reservation.request.retryExplanation ?? null) !==
        canonicalJson(input.retryExplanation)) ||
    reservation.previousInvocationId !== failed.invocationId ||
    reservation.invocationId !== current.providerInvocationId ||
    current.provider.attempt !== failed.attempt + 1 ||
    session.blindInvocationIds.at(-2) !== failed.invocationId ||
    session.blindInvocationIds.at(-1) !== reservation.invocationId
  ) {
    throw providerRetryInputStale();
  }
  return current;
}

function dispatchPreparedRetryInvocation(
  services: Pick<
    ProposeRuntime,
    'taskMandate' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  status: InvestigationStatus,
  options: ProposeResumeOptions,
): void {
  if (
    status.provider.state !== 'prepared' ||
    (!options.providerDriver && !options.providerDispatcher)
  ) {
    return;
  }
  dispatchMandatedProviderInvocation(
    services,
    cwd,
    status.providerInvocationId,
    (runtime, request) => {
      if (options.providerDriver) {
        options.providerDriver({ paths: runtime, request });
      } else if (options.providerDispatcher) {
        options.providerDispatcher(cwd, request.invocationId);
      }
    },
  );
}

function assertProviderRetrySessionBinding(
  current: InvestigationStatus,
  input: ProviderRetryEnvelope,
): void {
  if (
    input.investigationId !== current.investigationId ||
    input.changeId !== current.changeId ||
    canonicalJson(input.baseline) !== canonicalJson(current.baseline) ||
    input.intentDigest !== current.intentDigest ||
    input.blindManifestDigest !== current.blindManifestDigest
  ) {
    throw providerRetryInputStale();
  }
}

function assertProviderRetryFailureBinding(
  input: ProviderRetryEnvelope,
  failed: ReturnType<ProposeRuntime['provider']['readProviderInvocation']>,
  request: ProviderInvocationRequest,
): void {
  if (
    failed.investigationId !== input.investigationId ||
    failed.changeId !== input.changeId ||
    failed.invocationId !== input.failedInvocation.invocationId ||
    failed.attempt !== input.failedInvocation.attempt ||
    failed.revision !== input.failedInvocation.revision ||
    failed.requestDigest !== input.failedInvocation.requestDigest ||
    request.requestDigest !== input.failedInvocation.requestDigest ||
    failed.state !== 'failed' ||
    failed.failure === null ||
    failed.failure.kind !== 'retryable' ||
    sha256(canonicalJson(failed.failure)) !==
      input.failedInvocation.failureDigest
  ) {
    throw providerRetryInputStale();
  }
}

function providerRetryInputStale() {
  return workflowError(
    'PROVIDER_RETRY_INPUT_STALE',
    'Provider retry input is not bound to the exact failed survey attempt.',
    ExitCode.staleState,
  );
}

export function dispatchPreparedPlanReview(
  services: Pick<
    ProposeRuntime,
    'taskMandate' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  output: ProposeOutput,
  options: ProposeResumeOptions,
): void {
  if (
    output.planReview?.state !== 'prepared' ||
    (!options.providerDriver && !options.providerDispatcher)
  ) {
    return;
  }
  dispatchMandatedProviderInvocation(
    services,
    cwd,
    output.planReview.invocationId,
    (runtime, request) => {
      if (options.providerDriver) {
        options.providerDriver({ paths: runtime, request });
      } else if (options.providerDispatcher) {
        options.providerDispatcher(cwd, request.invocationId);
      }
    },
  );
}
