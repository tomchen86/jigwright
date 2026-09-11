/** Executes and recovers grant-bound publication through required live capabilities. */

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type PublishRunnerObservation,
  type PublishRunnerRequest,
  type PublishRunnerOutcome,
  type PublishRunnerQuery,
  type PublishRunner,
  type ExecutePublishOptions,
  type ExecutePublishResult,
  assertRunnerObservation,
  assertPublishObservation,
  terminalResult,
  isTerminal,
  requireTransactionId,
  exactDate,
  boundedReason,
  publishStateInvalid,
  assertPublishGrantPayload,
  type PublishRepositoryServices,
  type PublishRunnerFactory,
} from '../../modules/authority/publish-grant.ts';

import {
  PUBLISH_TRANSACTION_ENV,
  type ExternalEffectGrantInspection,
  type ExternalEffectTransitionOptions,
} from '../../modules/authority/external-effect-grant.ts';
import { type ExternalEffectGrantOperations } from './external-effect-grant.ts';
import { type TaskMandateServices } from '../../modules/authority/task-mandate-services.ts';
export type PublishExecutorServices = {
  grants: Pick<
    ExternalEffectGrantOperations,
    | 'consumeExternalEffectGrant'
    | 'inspectExternalEffectGrantForExecutor'
    | 'markExternalEffectDispatchIssued'
    | 'recordExternalEffectObservation'
    | 'reserveExternalEffectGrant'
    | 'terminalizeExternalEffectGrant'
  >;
  repository: PublishRepositoryServices;
  createProductionPublishRunner: PublishRunnerFactory;
  now: TaskMandateServices['now'];
  environment: () => NodeJS.ProcessEnv;
};
export function createPublishExecutor(services: PublishExecutorServices) {
  const {
    consumeExternalEffectGrant,
    inspectExternalEffectGrantForExecutor,
    markExternalEffectDispatchIssued,
    recordExternalEffectObservation,
    reserveExternalEffectGrant,
    terminalizeExternalEffectGrant,
  } = services.grants;
  const {
    discoverRepository,
    resolveSourceOid,
    remoteUrl: remoteUrlFor,
  } = services.repository;
  const {
    createProductionPublishRunner,
    now: clockNow,
    environment: readEnvironment,
  } = services;
  function executePublishGrant(
    cwd: string,
    grantId: string,
    options: ExecutePublishOptions,
  ): ExecutePublishResult {
    const now = exactDate(options.now ?? clockNow());
    const runner = options.runner ?? createProductionPublishRunner();
    let inspection = inspectExternalEffectGrantForExecutor(cwd, grantId, {
      now,
      signer: options.signer,
    });
    assertPublishGrant(cwd, inspection);
    if (inspection.state === 'expired') {
      inspection = reserveExternalEffectGrant(cwd, grantId, {
        ...transitionOptions(options, now),
      });
    }
    if (isTerminal(inspection)) return terminalResult(inspection, false);

    let freshDispatch = false;
    if (inspection.state === 'available') {
      inspection = reserveExternalEffectGrant(cwd, grantId, {
        ...transitionOptions(options, now),
      });
    }
    if (isTerminal(inspection)) return terminalResult(inspection, false);
    if (inspection.state === 'reserved') {
      inspection = markExternalEffectDispatchIssued(
        cwd,
        grantId,
        requireTransactionId(inspection),
        {
          ...transitionOptions(options, now),
        },
      );
      freshDispatch = inspection.state === 'dispatch-issued';
    }
    if (isTerminal(inspection)) return terminalResult(inspection, false);
    if (inspection.state === 'effect-observed') {
      assertPublishObservation(inspection);
      return terminalResult(
        consumeExternalEffectGrant(
          cwd,
          grantId,
          requireTransactionId(inspection),
          {
            ...transitionOptions(options, now),
          },
        ),
        true,
      );
    }
    if (inspection.state !== 'dispatch-issued') throw publishStateInvalid();

    const request = publishRunnerRequest(
      cwd,
      inspection,
      options.environment ?? readEnvironment(),
    );
    if (freshDispatch) {
      options.testAfterDispatchIssued?.(request);
      return dispatchAndFinalize(
        cwd,
        inspection,
        request,
        runner,
        options,
        false,
      );
    }

    if (!runner.query) {
      return terminalResult(
        terminalizeExternalEffectGrant(
          cwd,
          grantId,
          request.transactionId,
          'manual-reconciliation',
          'Dispatch was durably issued, but no queryable idempotency receipt is available.',
          transitionOptions(options, now),
        ),
        true,
      );
    }

    let queried: PublishRunnerQuery;
    try {
      queried = runner.query(request);
    } catch {
      queried = {
        state: 'unknown',
        reason: 'Queryable publish state could not be read.',
      };
    }
    options.testAfterRunnerResult?.(queried);
    if (queried.state === 'observed') {
      return observeAndConsume(
        cwd,
        inspection,
        queried.observation,
        options,
        true,
      );
    }
    if (queried.state === 'unknown') {
      return terminalResult(
        terminalizeExternalEffectGrant(
          cwd,
          grantId,
          request.transactionId,
          'manual-reconciliation',
          boundedReason(queried.reason),
          transitionOptions(options, now),
        ),
        true,
      );
    }
    if (now.getTime() >= Date.parse(inspection.payload.expiresAt)) {
      return terminalResult(
        terminalizeExternalEffectGrant(
          cwd,
          grantId,
          request.transactionId,
          'failed',
          'The publish activation window expired before a safe idempotent replay.',
          transitionOptions(options, now),
        ),
        true,
      );
    }
    return dispatchAndFinalize(cwd, inspection, request, runner, options, true);
  }

  function dispatchAndFinalize(
    cwd: string,
    inspection: ExternalEffectGrantInspection,
    request: PublishRunnerRequest,
    runner: PublishRunner,
    options: ExecutePublishOptions,
    replayed: boolean,
  ): ExecutePublishResult {
    let outcome: PublishRunnerOutcome;
    try {
      outcome = runner.dispatch(request);
    } catch {
      return terminalResult(
        terminalizeExternalEffectGrant(
          cwd,
          inspection.grantId,
          request.transactionId,
          'manual-reconciliation',
          'Publish runner failed after dispatch and external state is unknown.',
          {
            ...transitionOptions(options),
          },
        ),
        replayed,
      );
    }
    options.testAfterRunnerResult?.(outcome);
    if (outcome.state === 'observed') {
      return observeAndConsume(
        cwd,
        inspection,
        outcome.observation,
        options,
        replayed,
      );
    }
    return terminalResult(
      terminalizeExternalEffectGrant(
        cwd,
        inspection.grantId,
        request.transactionId,
        outcome.state === 'not-issued' ? 'failed' : 'manual-reconciliation',
        boundedReason(outcome.reason),
        {
          ...transitionOptions(options),
        },
      ),
      replayed,
    );
  }

  function observeAndConsume(
    cwd: string,
    inspection: ExternalEffectGrantInspection,
    observation: PublishRunnerObservation,
    options: ExecutePublishOptions,
    replayed: boolean,
  ): ExecutePublishResult {
    const transactionId = requireTransactionId(inspection);
    let observed: ExternalEffectGrantInspection;
    try {
      assertRunnerObservation(inspection, observation);
      observed = recordExternalEffectObservation(
        cwd,
        inspection.grantId,
        transactionId,
        observation,
        {
          ...transitionOptions(options),
        },
      );
    } catch {
      return terminalResult(
        terminalizeExternalEffectGrant(
          cwd,
          inspection.grantId,
          transactionId,
          'manual-reconciliation',
          'Publish produced a receipt that could not be bound to the signed exact effect.',
          {
            ...transitionOptions(options),
          },
        ),
        replayed,
      );
    }
    assertPublishObservation(observed);
    return terminalResult(
      consumeExternalEffectGrant(cwd, inspection.grantId, transactionId, {
        ...transitionOptions(options),
      }),
      replayed,
    );
  }

  function publishRunnerRequest(
    cwd: string,
    inspection: ExternalEffectGrantInspection,
    environment: NodeJS.ProcessEnv,
  ): PublishRunnerRequest {
    if (
      inspection.payload.target.kind !== 'git-ref' ||
      !inspection.transactionId ||
      !inspection.transactionToken
    ) {
      throw publishStateInvalid();
    }
    const repository = discoverRepository(cwd);
    return {
      repositoryRoot: repository.repositoryRoot,
      grantId: inspection.grantId,
      transactionId: inspection.transactionId,
      idempotencyKey: inspection.payload.idempotencyKey,
      target: inspection.payload.target,
      artifactDigest: inspection.payload.artifactDigest,
      prestateDigest: inspection.payload.prestateDigest,
      environment: {
        ...environment,
        [PUBLISH_TRANSACTION_ENV]: inspection.transactionToken,
      },
    };
  }

  function assertPublishGrant(
    cwd: string,
    inspection: ExternalEffectGrantInspection,
  ): void {
    assertPublishGrantPayload(inspection);
    const { payload } = inspection;
    const repository = discoverRepository(cwd);
    const resolved = resolveSourceOid(
      repository.repositoryRoot,
      payload.target.sourceOid,
    );
    const remoteUrl = remoteUrlFor(
      repository.repositoryRoot,
      payload.target.remoteName,
    );
    if (
      resolved !== payload.target.sourceOid ||
      repository.head !== payload.target.sourceOid ||
      remoteUrl !== payload.target.remoteUrl
    ) {
      throw workflowError(
        'PUBLISH_GRANT_STALE',
        'Repository artifact or remote differs from the signed publish grant.',
        ExitCode.staleState,
      );
    }
  }

  function transitionOptions(
    options: ExecutePublishOptions,
    now: Date = exactDate(options.now ?? clockNow()),
  ): ExternalEffectTransitionOptions {
    return {
      now,
      signer: options.signer,
      onAuditRecord: options.onAuditRecord,
      testAuditServiceHooks: options.testAuditServiceHooks,
    };
  }
  return executePublishGrant;
}
