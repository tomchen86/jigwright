/**
 * Recovers budget consumption receipts and publishes replacement provider
 * invocations with exact transaction lineage.
 *
 * Invariants:
 * - Recovery reuses the receipt for the replacement attempt before
 *   attempting another Grant consumption.
 */
// execution replacement publication; repository effects remain bound by the public module.
import type {
  ExecutionReplacementPublicationBindings,
  ExecutionReplacementPublicationBindingsTypes,
} from './execution-replacement.ts';
type InvestigationRuntimePaths =
  ExecutionReplacementPublicationBindingsTypes['InvestigationRuntimePaths'];
type ExecutionReplacementTransaction =
  ExecutionReplacementPublicationBindingsTypes['ExecutionReplacementTransaction'];
type ExecuteGrantedReplacementOptions =
  ExecutionReplacementPublicationBindingsTypes['ExecuteGrantedReplacementOptions'];
type ConsumedPlanReviewReplayPort =
  ExecutionReplacementPublicationBindingsTypes['ConsumedPlanReviewReplayPort'];
type ExecutionBudgetGrantRequest =
  ExecutionReplacementPublicationBindingsTypes['ExecutionBudgetGrantRequest'];
declare const inspectExecutionJob: ExecutionReplacementPublicationBindings['inspectExecutionJob'];

export function createExecutionReplacementPublication(
  bindings: () => ExecutionReplacementPublicationBindings,
) {
  function recoverReceipt(
    repositoryRoot: string,
    paths: InvestigationRuntimePaths,
    storeRoot: string,
    transaction: ExecutionReplacementTransaction,
    options: ExecuteGrantedReplacementOptions,
    assertOwned: () => void,
  ): ExecutionReplacementTransaction {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const {
      inspectExecutionBudgetGrantAuthorization,
      assertActiveTaskMandateBindingUnderLifecycleLock,
      parseMaintainerPolicy,
      runGit,
      consumeExecutionBudgetGrant,
      SimulatedExecutionReplacementCrash,
      createTransaction,
      writeTransaction,
      replacementTransactionPath,
    } = boundServices;
    const assertReceipt: ExecutionReplacementPublicationBindings['assertReceipt'] =
      boundServices.assertReceipt;

    if (transaction.receipt !== null) return transaction;
    const inspected = inspectExecutionBudgetGrantAuthorization(
      storeRoot,
      transaction.grantId,
    );
    let receipt = inspected.receipts.find(
      ({ attemptId }) => attemptId === transaction.replacementAttemptId,
    );
    if (receipt === undefined) {
      const mandateBinding = transaction.request.mandateBinding;
      assertActiveTaskMandateBindingUnderLifecycleLock(
        repositoryRoot,
        mandateBinding,
        assertOwned,
        { now: options.now },
      );
      const maintainerPolicy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repositoryRoot, [
            'show',
            'HEAD:workflow/maintainer-policy.json',
          ]),
        ),
      );
      assertOwned();
      receipt = consumeExecutionBudgetGrant(storeRoot, {
        grantId: transaction.grantId,
        workflowId: transaction.workflowId,
        epoch: transaction.epoch,
        jobId: transaction.jobId,
        attemptId: transaction.replacementAttemptId,
        mandateBinding,
        requestDigest: transaction.requestDigest,
        requestedChanges: transaction.request.requestedChanges,
        now: options.now ?? new Date(),
        audit: {
          repositoryRoot,
          repositoryIdentity: maintainerPolicy.repository.id,
        },
      });
      if (options.simulateCrashAfter === 'grant-consume-before-journal') {
        throw new SimulatedExecutionReplacementCrash(
          'grant-consume-before-journal',
        );
      }
    }
    assertReceipt(transaction, receipt);
    const { recordDigest: _recordDigest, ...transactionCore } = transaction;
    const next = createTransaction({
      ...transactionCore,
      phase: 'grant-consumed' as const,
      receipt,
      updatedAt: receipt.consumedAt,
    });
    writeTransaction(
      paths,
      replacementTransactionPath(storeRoot, transaction.transactionId),
      next,
      true,
    );
    if (options.simulateCrashAfter === 'grant-consumed') {
      throw new SimulatedExecutionReplacementCrash('grant-consumed');
    }
    return next;
  }

  function publishReplacement(
    cwd: string,
    transaction: ExecutionReplacementTransaction,
    options: ExecuteGrantedReplacementOptions = {},
  ): void {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const {
      loadInvestigationRuntimeContext,
      readProviderInvocation,
      replacementNotGrantable,
      completeInterruptedPlanReviewReplacement,
      getProposeStatus,
      createProviderRetryEnvelope,
      createPlanReviewRetryEnvelope,
      resumePropose,
      SimulatedExecutionReplacementCrash,
    } = boundServices;
    const assertReceipt: ExecutionReplacementPublicationBindings['assertReceipt'] =
      boundServices.assertReceipt;

    assertReceipt(transaction, transaction.receipt);
    const context = loadInvestigationRuntimeContext(cwd);
    if (isPublishedReplacement(cwd, transaction, options)) {
      return;
    }
    const failed = readProviderInvocation(
      context.runtime,
      transaction.failedInvocationId,
    );
    if (
      failed.purpose === 'task-diff-review' ||
      failed.purpose === 'task-implementation'
    ) {
      throw replacementNotGrantable();
    }
    // A previous republication may have died after the replacement reservation
    // was published but before its invocation record existed. That half-state
    // cannot render a status projection, so the WAL finishes the interrupted
    // tail directly from the transaction's own facts before consulting one.
    if (
      failed.purpose !== 'survey' &&
      completeInterruptedPlanReviewReplacement(cwd, {
        investigationId: failed.investigationId,
        changeId: failed.changeId,
        replacementRequest: transaction.replacementRequest,
        failedInvocationId: transaction.failedInvocationId,
        executionGrantId: transaction.grantId,
      }).published
    ) {
      assertPublishedReplacement(cwd, transaction, options);
      return;
    }
    const collaborationGrantValidation =
      consumedRoleResultReplayValidation(options);
    const output = getProposeStatus(
      cwd,
      failed.investigationId,
      collaborationGrantValidation,
    );
    const authorization = {
      grantId: transaction.grantId,
      grantRequest: transaction.request,
      receipt: transaction.receipt!,
      replacementRequest: transaction.replacementRequest,
    };
    const envelope =
      failed.purpose === 'survey'
        ? createProviderRetryEnvelope(cwd, output, {
            acknowledgeProviderCost: true,
          })
        : createPlanReviewRetryEnvelope(cwd, output, {
            acknowledgeProviderCost: true,
          });
    resumePropose(cwd, failed.changeId, envelope, {
      executionGrantAuthorization: authorization,
      ...(collaborationGrantValidation === undefined
        ? {}
        : { collaborationGrantValidation }),
      ...(options.simulateCrashAfter === 'plan-review-reservation-replaced'
        ? {
            simulateCrashAfterPlanReviewReplacementReservation: () => {
              throw new SimulatedExecutionReplacementCrash(
                'plan-review-reservation-replaced',
              );
            },
          }
        : {}),
    });
    assertPublishedReplacement(cwd, transaction, options);
  }

  function assertPublishedReplacement(
    cwd: string,
    transaction: ExecutionReplacementTransaction,
    options: ExecuteGrantedReplacementOptions,
  ): void {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const {
      loadInvestigationRuntimeContext,
      providerInvocationExists,
      replacementStale,
      readProviderInvocation,
      readProviderInvocationRequest,
      canonicalJson,
      getProposeStatus,
    } = boundServices;

    const context = loadInvestigationRuntimeContext(cwd);
    if (
      !providerInvocationExists(
        context.runtime,
        transaction.replacementInvocationId,
      )
    ) {
      throw replacementStale();
    }
    const record = readProviderInvocation(
      context.runtime,
      transaction.replacementInvocationId,
    );
    const request = readProviderInvocationRequest(
      context.runtime,
      transaction.replacementInvocationId,
    );
    if (
      record.attempt !==
        readProviderInvocation(context.runtime, transaction.failedInvocationId)
          .attempt +
          1 ||
      record.requestDigest !== transaction.replacementRequest.requestDigest ||
      canonicalJson(request) !== canonicalJson(transaction.replacementRequest)
    ) {
      throw replacementStale();
    }
    const output = getProposeStatus(
      cwd,
      record.investigationId,
      consumedRoleResultReplayValidation(options),
    );
    const referenced =
      record.purpose === 'survey'
        ? output.investigation?.kind === 'investigation' &&
          output.investigation.providerInvocationId === record.invocationId
        : output.planReview?.invocationId === record.invocationId;
    if (!referenced) throw replacementStale();
  }

  function isPublishedReplacement(
    cwd: string,
    transaction: ExecutionReplacementTransaction,
    options: ExecuteGrantedReplacementOptions,
  ): boolean {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const {
      loadInvestigationRuntimeContext,
      providerInvocationExists,
      readProviderInvocation,
      getProposeStatus,
    } = boundServices;

    const context = loadInvestigationRuntimeContext(cwd);
    if (
      !providerInvocationExists(
        context.runtime,
        transaction.replacementInvocationId,
      )
    ) {
      return false;
    }
    const record = readProviderInvocation(
      context.runtime,
      transaction.replacementInvocationId,
    );
    const output = getProposeStatus(
      cwd,
      record.investigationId,
      consumedRoleResultReplayValidation(options),
    );
    return record.purpose === 'survey'
      ? output.investigation?.kind === 'investigation' &&
          output.investigation.providerInvocationId === record.invocationId
      : output.planReview?.invocationId === record.invocationId;
  }

  function consumedRoleResultReplayValidation(
    options: Pick<ExecuteGrantedReplacementOptions, 'consumedRoleResultReplay'>,
  ):
    | {
        consumedRoleResultReplay: ConsumedPlanReviewReplayPort;
        consumedPlanReviewReplay: ConsumedPlanReviewReplayPort;
      }
    | undefined {
    return options.consumedRoleResultReplay === undefined
      ? undefined
      : {
          consumedRoleResultReplay: options.consumedRoleResultReplay,
          consumedPlanReviewReplay: options.consumedRoleResultReplay,
        };
  }

  function requestExecutionReplacementBytes(
    inspection: ReturnType<typeof inspectExecutionJob>,
    timeoutMs: number,
    previousProviderPolicyDigest: string,
    providerPolicyDigest: string,
    providerPolicyTimeoutCeilingMs: number,
  ): string {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const {
      replacementNotGrantable,
      mergeExactChanges,
      createExecutionBudgetGrantRequest,
      deterministicUuid,
      requireExecutionJobMandateBinding,
      replacementRationale,
      canonicalExecutionBudgetGrantRequest,
    } = boundServices;

    const previous = inspection.attempts.at(-1);
    const base = inspection.latestFailure?.decision.requiredGrant;
    if (
      previous === undefined ||
      previous.failure === null ||
      base === undefined
    ) {
      throw replacementNotGrantable();
    }
    const previewChanges = [
      {
        path: '/timeoutMs',
        from: previous.policySnapshot.timeoutMs,
        to: timeoutMs,
      },
    ];
    const changes = mergeExactChanges([
      ...base.requestedChanges,
      ...previewChanges,
      ...(timeoutMs > providerPolicyTimeoutCeilingMs
        ? [
            {
              path: '/providerPolicy/limits/timeoutMs',
              from: providerPolicyTimeoutCeilingMs,
              to: timeoutMs,
            },
          ]
        : []),
      ...(previousProviderPolicyDigest === providerPolicyDigest
        ? []
        : [
            {
              path: '/providerPolicyDigest',
              from: previousProviderPolicyDigest,
              to: providerPolicyDigest,
            },
          ]),
    ]);
    const request = createExecutionBudgetGrantRequest({
      requestId: deterministicUuid({
        kind: 'execution-replacement-request',
        jobId: inspection.job.jobId,
        failedAttemptId: previous.attemptId,
        changes,
      }),
      workflowId: inspection.workflow.workflowId,
      epoch: inspection.job.epoch,
      jobId: inspection.job.jobId,
      mandateBinding: requireExecutionJobMandateBinding(inspection.job),
      requestedChanges: changes,
      rationale: replacementRationale(
        previous,
        timeoutMs,
        providerPolicyDigest,
      ),
      expiresAfterAttempts: 1,
      createdAt: new Date(previous.updatedAt),
    });
    assertCompleteReplacementDelta(
      request,
      inspection.job.retryPolicy.maxAttempts,
      previous.policySnapshot.timeoutMs,
      timeoutMs,
      providerPolicyTimeoutCeilingMs,
    );
    return canonicalExecutionBudgetGrantRequest(request);
  }

  function assertCurrentTransactionLineage(
    cwd: string,
    transaction: ExecutionReplacementTransaction,
  ): void {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const {
      inspectExecutionJob,
      loadInvestigationRuntimeContext,
      readProviderInvocation,
      readProviderInvocationRequest,
      readPersistedRequest,
      readRequestBinding,
      loadAiAdapterPolicy,
      replacementTimeout,
      createProviderInvocationRequest,
      digestCanonical,
      inspectExecutionBudgetGrantAuthorization,
      digestText,
      canonicalJson,
      replacementStale,
    } = boundServices;

    const inspection = inspectExecutionJob(cwd, transaction.jobId);
    const failed = inspection.attempts.find(
      ({ attemptId }) => attemptId === transaction.failedAttemptId,
    );
    const context = loadInvestigationRuntimeContext(cwd);
    const record = readProviderInvocation(
      context.runtime,
      transaction.failedInvocationId,
    );
    const failedRequest = readProviderInvocationRequest(
      context.runtime,
      transaction.failedInvocationId,
    );
    const persistedRequest = readPersistedRequest(
      context.runtime,
      context.lifecycleRuntime.root,
      transaction.requestDigest,
    );
    const binding = readRequestBinding(
      context.runtime,
      context.lifecycleRuntime.root,
      transaction.requestDigest,
    );
    const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
    const timeoutMs = replacementTimeout(transaction.request);
    const expectedReplacementRequest = createProviderInvocationRequest({
      invocationId: transaction.replacementInvocationId,
      nonce: `execution-grant-retry-${digestCanonical({ grantId: transaction.grantId, requestDigest: transaction.requestDigest }).slice(7)}`,
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
      writeAllowedPaths: [...failedRequest.writeAllowedPaths],
      outputSchema: failedRequest.outputSchema,
      evaluatorVersion: failedRequest.evaluatorVersion,
      policyDigest: binding.providerPolicyDigest,
      limits: {
        timeoutMs,
        aggregateOutputBytes: failedRequest.limits.aggregateOutputBytes,
      },
    });
    const grant = inspectExecutionBudgetGrantAuthorization(
      context.lifecycleRuntime.root,
      transaction.grantId,
    );
    const durableReceipt = grant.receipts.find(
      ({ attemptId }) => attemptId === transaction.replacementAttemptId,
    );
    if (
      inspection.workflow.workflowId !== transaction.workflowId ||
      inspection.job.epoch !== transaction.epoch ||
      inspection.job.contextDigest !== transaction.contextDigest ||
      inspection.acceptedAttemptId !== null ||
      failed?.failure?.fingerprint !== transaction.failureFingerprint ||
      record.revision !== transaction.failedInvocationRevision ||
      record.state !== 'failed' ||
      binding.failedAttemptId !== transaction.failedAttemptId ||
      binding.failedInvocationId !== transaction.failedInvocationId ||
      binding.failedInvocationRevision !==
        transaction.failedInvocationRevision ||
      binding.failureFingerprint !== transaction.failureFingerprint ||
      binding.providerPolicyDigest !== policy.digest ||
      binding.providerPolicyDocumentDigest !== digestText(policy.document) ||
      canonicalJson(persistedRequest) !== canonicalJson(transaction.request) ||
      canonicalJson(expectedReplacementRequest) !==
        canonicalJson(transaction.replacementRequest) ||
      grant.payload.requestDigest !== transaction.requestDigest ||
      (transaction.receipt !== null &&
        (durableReceipt === undefined ||
          canonicalJson(durableReceipt) !== canonicalJson(transaction.receipt)))
    ) {
      throw replacementStale();
    }
  }

  function assertCompleteReplacementDelta(
    request: ExecutionBudgetGrantRequest,
    maxAttempts: number,
    oldTimeoutMs: number,
    timeoutMs: number,
    providerPolicyTimeoutCeilingMs: number,
  ): void {
    const boundServices: ExecutionReplacementPublicationBindings = bindings();
    const { canonicalJson, grantMismatch } = boundServices;

    const maxAttemptsChange = request.requestedChanges.find(
      ({ path }) => path === '/retryPolicy/maxAttempts',
    );
    const timeoutChange = request.requestedChanges.find(
      ({ path }) => path === '/timeoutMs',
    );
    const ceilingChange = request.requestedChanges.find(
      ({ path }) => path === '/providerPolicy/limits/timeoutMs',
    );
    if (
      maxAttemptsChange === undefined ||
      timeoutChange === undefined ||
      canonicalJson(maxAttemptsChange) !==
        canonicalJson({
          path: '/retryPolicy/maxAttempts',
          from: maxAttempts,
          to: maxAttempts + 1,
        }) ||
      canonicalJson(timeoutChange) !==
        canonicalJson({
          path: '/timeoutMs',
          from: oldTimeoutMs,
          to: timeoutMs,
        }) ||
      (timeoutMs > providerPolicyTimeoutCeilingMs
        ? canonicalJson(ceilingChange) !==
          canonicalJson({
            path: '/providerPolicy/limits/timeoutMs',
            from: providerPolicyTimeoutCeilingMs,
            to: timeoutMs,
          })
        : ceilingChange !== undefined)
    ) {
      throw grantMismatch(
        'GrantRequest must contain exactly one maxAttempts increment and the timeout delta.',
      );
    }
  }
  return {
    recoverReceipt,
    publishReplacement,
    assertPublishedReplacement,
    requestExecutionReplacementBytes,
    assertCurrentTransactionLineage,
    assertCompleteReplacementDelta,
  };
}
