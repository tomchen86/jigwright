/**
 * Requests and executes Grant-bound replacements for failed provider
 * attempts.
 *
 * Invariants:
 * - This replacement path excludes task implementation and task diff review
 *   invocations.
 */
import type { TaskMandateActiveBinding } from '../../modules/authority/task-mandate-access-contract.ts';

import { executionReplacementBudgetChanges } from './execution-replacement-budget.ts';
import {
  parseProviderRetryExplanation,
  type ProviderRetryExplanation,
} from '../../modules/provider-orchestration/provider-retry-explanation.ts';
import { createExecutionReplacementRecords } from './execution-replacement-records.ts';
import { createExecutionReplacementPublication } from './execution-replacement-publication.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadAiAdapterPolicy } from '../../runtime/provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { requireExecutionJobMandateBinding } from '../../modules/provider-orchestration/execution-core.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  createExecutionBudgetGrantRequest,
  parseExecutionBudgetGrantRequest,
  type ExecutionBudgetConsumeReceipt,
  type ExecutionBudgetGrantRequest,
} from '../../modules/authority/execution-governance-grant-contracts.ts';
import {
  consumeExecutionBudgetGrant,
  inspectExecutionBudgetGrantAuthorization,
} from '../../runtime/storage-journal/execution-budget-grants.ts';
import {
  inspectExecutionJob,
  inspectProviderExecutionJobSource,
  previewProviderReplacementGrantDelta,
} from '../../runtime/provider-execution/execution-runtime.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit } from '../../runtime/repository-transaction/git.ts';
import {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from '../../runtime/storage-journal/investigation-private-files.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../../runtime/repository-observation/investigation-runtime-context.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type { InvestigationRuntimePaths } from '../../runtime/paths/runtime-paths.ts';
import type { ProposeOperations } from '../propose/propose-orchestrator.ts';
export type ExecutionReplacementProposePort = Pick<
  ProposeOperations,
  | 'completeInterruptedPlanReviewReplacement'
  | 'createPlanReviewRetryEnvelope'
  | 'createProviderRetryEnvelope'
  | 'getProposeStatus'
  | 'resumePropose'
> & {
  taskMandate: Pick<
    TaskMandateActiveBinding,
    'assertActiveTaskMandateBindingUnderLifecycleLock'
  >;
};
import {
  MAX_PROVIDER_LIMITS,
  createProviderInvocationRequest,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  providerInvocationExists,
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../../runtime/storage-journal/provider-invocation-store.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';
import type { ConsumedRoleReplayPort } from '../../modules/provider-orchestration/role-admission-contracts.ts';

export type ExecutionRetryRequestResult = Readonly<{
  schemaVersion: 1;
  requestPath: string;
  requestDigest: string;
  request: ExecutionBudgetGrantRequest;
  bindingPath: string;
}>;

/**
 * Enumerate exact durable replacement GrantRequests without creating runtime
 * directories or requiring the later binding publication to have completed.
 */
export function listExecutionReplacementGrantRequestDigests(
  cwd: string,
): readonly string[] {
  const context = loadInvestigationRuntimeContext(cwd);
  const requestsDirectory = path.join(
    context.lifecycleRuntime.root,
    'execution-replacements',
    'requests',
  );
  const stats = fs.lstatSync(requestsDirectory, { throwIfNoEntry: false });
  if (stats === undefined) return Object.freeze([]);
  assertPrivateInvestigationDirectory(
    context.runtime,
    requestsDirectory,
    replacementUnsafe,
  );
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(requestsDirectory) !== requestsDirectory
  ) {
    throw replacementUnsafe();
  }
  const requestDigests = fs
    .readdirSync(requestsDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const match = entry.name.match(/^([0-9a-f]{64})\.json$/);
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw replacementUnsafe();
      }
      const requestDigest = `sha256:${match[1]!}`;
      readPersistedRequest(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      return requestDigest;
    });
  return Object.freeze(requestDigests);
}

type ExecutionReplacementRequestBinding = Readonly<{
  schemaVersion: 1;
  kind: 'execution-replacement-request-binding';
  requestDigest: string;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureFingerprint: string;
  providerPolicyDigest: string;
  providerPolicyDocumentDigest: string;
  budgetScope?: 'next-attempt';
  retryExplanation?: ProviderRetryExplanation;
  recordDigest: string;
}>;

export type ExecutionReplacementPhase =
  | 'prepared'
  | 'grant-consumed'
  | 'invocation-published'
  | 'dispatch-issued'
  | 'complete';

export type ExecutionReplacementTransaction = Readonly<{
  schemaVersion: 1;
  kind: 'execution-replacement-transaction';
  transactionId: string;
  phase: ExecutionReplacementPhase;
  grantId: string;
  requestDigest: string;
  request: ExecutionBudgetGrantRequest;
  workflowId: string;
  epoch: number;
  contextDigest: string;
  jobId: string;
  failedAttemptId: string;
  failedInvocationId: string;
  failedInvocationRevision: number;
  failureFingerprint: string;
  replacementAttemptId: string;
  replacementInvocationId: string;
  replacementRequest: ReturnType<typeof createProviderInvocationRequest>;
  receipt: ExecutionBudgetConsumeReceipt | null;
  createdAt: string;
  updatedAt: string;
  recordDigest: string;
}>;

export type ExecuteGrantedReplacementOptions = {
  now?: Date;
  providerDispatcher?: (cwd: string, invocationId: string) => unknown;
  consumedRoleResultReplay?: ConsumedRoleReplayPort;
  simulateCrashAfter?:
    | 'prepared'
    | 'grant-consume-before-journal'
    | 'grant-consumed'
    | 'plan-review-reservation-replaced'
    | 'invocation-published';
};

export class SimulatedExecutionReplacementCrash extends Error {
  readonly phase: NonNullable<
    ExecuteGrantedReplacementOptions['simulateCrashAfter']
  >;

  constructor(
    phase: NonNullable<ExecuteGrantedReplacementOptions['simulateCrashAfter']>,
  ) {
    super(`Simulated execution replacement crash after ${phase}.`);
    this.phase = phase;
  }
}

/** Read-only view of the exact exception; publication remains in retry-request. */
export function previewExecutionReplacementRequest(
  propose: ExecutionReplacementProposePort,
  cwd: string,
  jobId: string,
  input: { timeoutMs: number; retryExplanation?: ProviderRetryExplanation },
): ExecutionBudgetGrantRequest {
  const { requestExecutionReplacementBytes } =
    createReplacementPublication(propose);

  assertTimeout(input.timeoutMs);
  if (input.retryExplanation !== undefined)
    parseProviderRetryExplanation(input.retryExplanation);
  const inspection = inspectExecutionJob(cwd, jobId);
  const source = inspectProviderExecutionJobSource(cwd, jobId);
  const policy = loadAiAdapterPolicy(
    loadInvestigationRuntimeContext(cwd).git.repositoryRoot,
  );
  return parseExecutionBudgetGrantRequest(
    requestExecutionReplacementBytes(
      inspection,
      input.timeoutMs,
      source.request.policyDigest,
      policy.digest,
      policy.policy.limits.timeoutMs,
      {
        budgetChanges: executionReplacementBudgetChanges(
          inspection,
          input.timeoutMs,
          policy,
        ),
        retryExplanation: input.retryExplanation,
      },
    ),
  );
}

export function requestExecutionReplacement(
  propose: ExecutionReplacementProposePort,
  cwd: string,
  requestedJobId: string,
  input: { timeoutMs: number; retryExplanation?: ProviderRetryExplanation },
): ExecutionRetryRequestResult {
  const { requestExecutionReplacementBytes } =
    createReplacementPublication(propose);

  assertTimeout(input.timeoutMs);
  if (input.retryExplanation !== undefined)
    parseProviderRetryExplanation(input.retryExplanation);
  const context = loadInvestigationRuntimeContext(cwd);
  return withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      const inspection = inspectExecutionJob(cwd, requestedJobId);
      const source = inspectProviderExecutionJobSource(cwd, requestedJobId);
      if (
        source.record.purpose === 'task-diff-review' ||
        source.record.purpose === 'task-implementation'
      ) {
        throw replacementNotGrantable();
      }
      const previous = inspection.attempts.at(-1);
      const grantBase = inspection.latestFailure?.decision.requiredGrant;
      if (
        grantBase === undefined &&
        previous?.failure !== null &&
        inspection.acceptedAttemptId === null &&
        (source.record.purpose === 'survey' ||
          source.record.purpose === 'plan-review')
      ) {
        throw workflowError(
          'EXECUTION_REPLACEMENT_GRANT_NOT_AVAILABLE',
          'This retry needs no budget Grant. Fill the failure assessment and planned action from job retry-preview, then submit them to job retry-request --input.',
          ExitCode.guard,
          {
            recovery: `pnpm workflow job retry-preview ${requestedJobId} --json`,
          },
        );
      }
      if (
        previous === undefined ||
        previous.failure === null ||
        grantBase === undefined ||
        inspection.acceptedAttemptId !== null
      ) {
        throw replacementNotGrantable();
      }
      previewProviderReplacementGrantDelta(cwd, requestedJobId, {
        timeoutMs: input.timeoutMs,
        now: previous.updatedAt,
      });
      const providerPolicy = loadAiAdapterPolicy(context.git.repositoryRoot);
      const request = parseExecutionBudgetGrantRequest(
        requestExecutionReplacementBytes(
          inspection,
          input.timeoutMs,
          source.request.policyDigest,
          providerPolicy.digest,
          providerPolicy.policy.limits.timeoutMs,
          {
            budgetChanges: executionReplacementBudgetChanges(
              inspection,
              input.timeoutMs,
              providerPolicy,
            ),
            retryExplanation: input.retryExplanation,
          },
        ),
      );
      const requestDigest = digestText(
        canonicalExecutionBudgetGrantRequest(request),
      );
      const requestPath = replacementRequestPath(
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const bindingPath = replacementRequestBindingPath(
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const binding = createRequestBinding({
        requestDigest,
        workflowId: inspection.workflow.workflowId,
        epoch: inspection.job.epoch,
        contextDigest: inspection.job.contextDigest,
        jobId: inspection.job.jobId,
        failedAttemptId: previous.attemptId,
        failedInvocationId: source.record.invocationId,
        failedInvocationRevision: source.record.revision,
        failureFingerprint: previous.failure.fingerprint,
        providerPolicyDigest: providerPolicy.digest,
        providerPolicyDocumentDigest: digestText(providerPolicy.document),
        budgetScope: 'next-attempt',
        ...(input.retryExplanation === undefined
          ? {}
          : { retryExplanation: input.retryExplanation }),
      });
      assertOwned();
      createPrivateCanonicalJson(
        context.runtime,
        requestPath,
        request,
        replacementUnsafe,
        'EXECUTION_REPLACEMENT_REQUEST_CONFLICT',
      );
      createPrivateCanonicalJson(
        context.runtime,
        bindingPath,
        binding,
        replacementUnsafe,
        'EXECUTION_REPLACEMENT_REQUEST_CONFLICT',
      );
      assertOwned();
      return Object.freeze({
        schemaVersion: 1,
        requestPath,
        requestDigest,
        request,
        bindingPath,
      });
    },
  );
}

export function executeGrantedReplacement(
  propose: ExecutionReplacementProposePort,
  cwd: string,
  requestedJobId: string,
  grantId: string,
  options: ExecuteGrantedReplacementOptions = {},
): ExecutionReplacementTransaction {
  const {
    recoverReceipt,
    publishReplacement,
    assertPublishedReplacement,
    requestExecutionReplacementBytes,
    assertCurrentTransactionLineage,
  } = createReplacementPublication(propose);

  const context = loadInvestigationRuntimeContext(cwd);
  const grant = inspectExecutionBudgetGrantAuthorization(
    context.lifecycleRuntime.root,
    grantId,
  );
  if (grant.payload.jobId !== requestedJobId) {
    throw grantMismatch('Execution-budget grant belongs to another Job.');
  }
  if (
    inspectProviderExecutionJobSource(cwd, requestedJobId).record.purpose ===
    'task-diff-review'
  ) {
    throw replacementNotGrantable();
  }
  const request = readPersistedRequest(
    context.runtime,
    context.lifecycleRuntime.root,
    grant.payload.requestDigest,
  );
  const requestBinding = readRequestBinding(
    context.runtime,
    context.lifecycleRuntime.root,
    grant.payload.requestDigest,
  );
  if (
    canonicalJson(request.requestedChanges) !==
      canonicalJson(grant.payload.allowedChanges) ||
    request.workflowId !== grant.payload.workflowId ||
    request.epoch !== grant.payload.epoch ||
    request.jobId !== grant.payload.jobId ||
    canonicalJson(request.mandateBinding) !==
      canonicalJson(grant.payload.mandateBinding)
  ) {
    throw grantMismatch('Grant does not sign the canonical persisted request.');
  }
  if (
    requestBinding.requestDigest !== grant.payload.requestDigest ||
    requestBinding.workflowId !== request.workflowId ||
    requestBinding.epoch !== request.epoch ||
    requestBinding.jobId !== request.jobId
  ) {
    throw grantMismatch('Grant request binding is stale or inconsistent.');
  }
  const timeoutMs = replacementTimeout(
    request,
    readProviderInvocationRequest(
      context.runtime,
      requestBinding.failedInvocationId,
    ).limits.timeoutMs,
  );
  const requestDigest = digestText(
    canonicalExecutionBudgetGrantRequest(request),
  );
  const replacementInvocationId = `invocation-grant-retry-${digestCanonical({
    grantId,
    requestDigest,
  }).slice(7, 47)}`;
  const replacementAttemptId = `attempt-provider-${replacementInvocationId}`;
  const transactionId = digestCanonical({
    kind: 'execution-replacement-transaction',
    grantId,
    requestDigest,
    replacementAttemptId,
  });
  const transactionPath = replacementTransactionPath(
    context.lifecycleRuntime.root,
    transactionId,
  );

  let transaction = withRepositoryLifecycleOperation(
    context.lifecycleRuntime,
    (assertOwned) => {
      const lockedRequest = readPersistedRequest(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const lockedBinding = readRequestBinding(
        context.runtime,
        context.lifecycleRuntime.root,
        requestDigest,
      );
      const lockedGrant = inspectExecutionBudgetGrantAuthorization(
        context.lifecycleRuntime.root,
        grantId,
      );
      if (
        canonicalJson(lockedRequest) !== canonicalJson(request) ||
        canonicalJson(lockedBinding) !== canonicalJson(requestBinding) ||
        canonicalJson(lockedGrant.payload) !== canonicalJson(grant.payload)
      ) {
        throw replacementStale();
      }
      const existing = readTransactionIfPresent(
        context.runtime,
        transactionPath,
      );
      if (existing !== null) {
        assertTransactionIdentity(existing, {
          transactionId,
          grantId,
          requestDigest,
          jobId: requestedJobId,
          replacementAttemptId,
          replacementInvocationId,
        });
        assertCurrentTransactionLineage(cwd, existing);
        return recoverReceipt(
          context.git.repositoryRoot,
          context.runtime,
          context.lifecycleRuntime.root,
          existing,
          options,
          assertOwned,
        );
      }

      const inspection = inspectExecutionJob(cwd, requestedJobId);
      const source = inspectProviderExecutionJobSource(cwd, requestedJobId);
      const failedAttempt = inspection.attempts.at(-1);
      if (
        inspection.workflow.workflowId !== request.workflowId ||
        inspection.job.epoch !== request.epoch ||
        inspection.job.contextDigest !== source.projection.job.contextDigest ||
        inspection.acceptedAttemptId !== null ||
        failedAttempt === undefined ||
        failedAttempt.failure === null ||
        failedAttempt.attemptId !== source.projection.attempt.attemptId ||
        source.record.state !== 'failed' ||
        source.record.failure?.kind !== 'retryable'
      ) {
        throw replacementStale();
      }
      const jobMandateBinding = requireExecutionJobMandateBinding(
        inspection.job,
      );
      if (
        canonicalJson(jobMandateBinding) !==
          canonicalJson(request.mandateBinding) ||
        canonicalJson(source.record.mandateBinding ?? null) !==
          canonicalJson(jobMandateBinding)
      ) {
        throw grantMismatch(
          'Grant does not match the durable provider invocation Task Mandate binding.',
        );
      }
      const policy = loadAiAdapterPolicy(context.git.repositoryRoot);
      const expected = requestExecutionReplacementBytes(
        inspection,
        timeoutMs,
        source.request.policyDigest,
        requestBinding.providerPolicyDigest,
        policy.policy.limits.timeoutMs,
        requestBinding.budgetScope === 'next-attempt'
          ? {
              budgetChanges: executionReplacementBudgetChanges(
                inspection,
                timeoutMs,
                policy,
              ),
              retryExplanation: requestBinding.retryExplanation,
            }
          : undefined,
      );
      if (expected !== canonicalExecutionBudgetGrantRequest(request)) {
        throw grantMismatch(
          'Persisted request is not the exact complete delta for the current failed Attempt.',
        );
      }
      if (
        policy.digest !== requestBinding.providerPolicyDigest ||
        digestText(policy.document) !==
          requestBinding.providerPolicyDocumentDigest
      ) {
        throw grantMismatch(
          'Executable provider policy changed after the grant request was persisted.',
        );
      }
      if (
        requestBinding.contextDigest !== inspection.job.contextDigest ||
        requestBinding.failedAttemptId !== failedAttempt.attemptId ||
        requestBinding.failedInvocationId !== source.record.invocationId ||
        requestBinding.failedInvocationRevision !== source.record.revision ||
        requestBinding.failureFingerprint !== failedAttempt.failure.fingerprint
      ) {
        throw replacementStale();
      }
      const replacementRequest = createProviderInvocationRequest({
        invocationId: replacementInvocationId,
        nonce: `execution-grant-retry-${digestCanonical({ grantId, requestDigest }).slice(7)}`,
        purpose: source.request.purpose,
        providerId: source.request.providerId,
        roleAssignment: source.request.roleAssignment,
        capabilityProfile: source.request.capabilityProfile,
        repositoryId: source.request.repositoryId,
        baseCommit: source.request.baseCommit,
        baseTree: source.request.baseTree,
        targetDigest: source.request.targetDigest,
        inputManifestDigest: source.request.inputManifestDigest,
        authorizationNodeId: source.request.authorizationNodeId,
        writeAllowedPaths: [...source.request.writeAllowedPaths],
        outputSchema: source.request.outputSchema,
        evaluatorVersion: source.request.evaluatorVersion,
        policyDigest: requestBinding.providerPolicyDigest,
        ...(requestBinding.retryExplanation === undefined
          ? {}
          : { retryExplanation: requestBinding.retryExplanation }),
        limits: {
          timeoutMs,
          aggregateOutputBytes: source.request.limits.aggregateOutputBytes,
        },
      });
      const now = source.record.updatedAt;
      let prepared = createTransaction({
        schemaVersion: 1,
        kind: 'execution-replacement-transaction',
        transactionId,
        phase: 'prepared',
        grantId,
        requestDigest,
        request,
        workflowId: inspection.workflow.workflowId,
        epoch: inspection.job.epoch,
        contextDigest: inspection.job.contextDigest,
        jobId: inspection.job.jobId,
        failedAttemptId: failedAttempt.attemptId,
        failedInvocationId: source.record.invocationId,
        failedInvocationRevision: source.record.revision,
        failureFingerprint: failedAttempt.failure.fingerprint,
        replacementAttemptId,
        replacementInvocationId,
        replacementRequest,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      });
      assertOwned();
      writeTransaction(context.runtime, transactionPath, prepared, false);
      if (options.simulateCrashAfter === 'prepared') {
        throw new SimulatedExecutionReplacementCrash('prepared');
      }
      prepared = recoverReceipt(
        context.git.repositoryRoot,
        context.runtime,
        context.lifecycleRuntime.root,
        prepared,
        options,
        assertOwned,
      );
      return prepared;
    },
  );

  if (transaction.phase === 'grant-consumed') {
    publishReplacement(cwd, transaction, options);
    transaction = withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      () =>
        advanceTransaction(
          context.runtime,
          transactionPath,
          transaction,
          'invocation-published',
          options.now?.toISOString() ?? new Date().toISOString(),
        ),
    );
    if (options.simulateCrashAfter === 'invocation-published') {
      throw new SimulatedExecutionReplacementCrash('invocation-published');
    }
  }
  if (transaction.phase === 'invocation-published') {
    assertPublishedReplacement(cwd, transaction, options);
    transaction = withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      () => {
        const durable = readTransactionIfPresent(
          context.runtime,
          transactionPath,
        );
        if (durable === null) throw replacementUnsafe();
        if (durable.phase !== 'invocation-published') return durable;
        options.providerDispatcher?.(cwd, durable.replacementInvocationId);
        return advanceTransaction(
          context.runtime,
          transactionPath,
          durable,
          'dispatch-issued',
          options.now?.toISOString() ?? new Date().toISOString(),
        );
      },
    );
  }
  if (transaction.phase === 'dispatch-issued') {
    transaction = withRepositoryLifecycleOperation(
      context.lifecycleRuntime,
      () =>
        advanceTransaction(
          context.runtime,
          transactionPath,
          transaction,
          'complete',
          options.now?.toISOString() ?? new Date().toISOString(),
        ),
    );
  }
  return transaction;
}

function replacementRationale(
  previous: ReturnType<typeof inspectExecutionJob>['attempts'][number],
  timeoutMs: number,
  providerPolicyDigest: string,
  retryExplanation?: ProviderRetryExplanation,
): string {
  if (previous.failure === null || !isProviderDigest(providerPolicyDigest)) {
    throw replacementStale();
  }
  const rationale =
    `Authorize exactly Attempt ${previous.attemptNumber + 1} after failed ${previous.attemptId} ` +
    `(${previous.failure.code}, ${previous.failure.fingerprint}): ` +
    (timeoutMs === previous.policySnapshot.timeoutMs
      ? `authorize the listed extra capacity once and keep timeout ${timeoutMs}ms under provider policy ${providerPolicyDigest}.`
      : `extend maxAttempts once and change timeout ${previous.policySnapshot.timeoutMs}ms to ${timeoutMs}ms under provider policy ${providerPolicyDigest}.`);
  return (
    rationale +
    (retryExplanation === undefined
      ? ''
      : ` Failure assessment: ${retryExplanation.failureReason.replaceAll('\0', '').slice(0, 120).trim()}. Planned action: ${retryExplanation.plannedAction.replaceAll('\0', '').slice(0, 120).trim()}.`)
  );
}

function mergeExactChanges(
  changes: ExecutionBudgetGrantRequest['requestedChanges'],
): ExecutionBudgetGrantRequest['requestedChanges'] {
  const byPath = new Map<string, (typeof changes)[number]>();
  for (const change of changes) {
    const existing = byPath.get(change.path);
    if (
      existing !== undefined &&
      canonicalJson(existing) !== canonicalJson(change)
    ) {
      throw grantMismatch(`Conflicting replacement delta at ${change.path}.`);
    }
    byPath.set(change.path, structuredClone(change));
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function replacementTimeout(
  request: ExecutionBudgetGrantRequest,
  previousTimeoutMs: number,
): number {
  const change = request.requestedChanges.find(
    ({ path }) => path === '/timeoutMs',
  );
  if (change === undefined) return previousTimeoutMs;
  if (!Number.isSafeInteger(change.to)) {
    throw grantMismatch('GrantRequest has no exact timeout replacement delta.');
  }
  assertTimeout(change.to as number);
  return change.to as number;
}

function assertTimeout(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PROVIDER_LIMITS.timeoutMs
  ) {
    throw workflowError(
      'EXECUTION_REPLACEMENT_TIMEOUT_INVALID',
      'Replacement timeout must be a bounded positive integer.',
      ExitCode.usage,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return canonicalJson(actual) === canonicalJson(sortedExpected);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isProviderDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,191}$/.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function deterministicUuid(value: unknown): string {
  const hex = crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function replacementNotGrantable() {
  return workflowError(
    'EXECUTION_REPLACEMENT_GRANT_NOT_AVAILABLE',
    'The current failed Attempt has no bounded replacement grant request.',
    ExitCode.guard,
  );
}

function grantMismatch(message: string) {
  return workflowError(
    'EXECUTION_REPLACEMENT_GRANT_MISMATCH',
    message,
    ExitCode.guard,
  );
}

function replacementStale() {
  return workflowError(
    'EXECUTION_REPLACEMENT_STALE',
    'Job, epoch, context, failure, or provider revision changed before replacement dispatch.',
    ExitCode.staleState,
  );
}

function replacementUnsafe() {
  return workflowError(
    'EXECUTION_REPLACEMENT_STORE_UNSAFE',
    'Durable execution replacement state is malformed or unsafe.',
    ExitCode.staleState,
  );
}

export type ExecutionReplacementRecordsBindings = {
  digestCanonical: typeof digestCanonical;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  isDigest: typeof isDigest;
  isProviderDigest: typeof isProviderDigest;
  isIdentity: typeof isIdentity;
  replacementUnsafe: typeof replacementUnsafe;
  isUuid: typeof isUuid;
  isTimestamp: typeof isTimestamp;
  parseExecutionBudgetGrantRequest: typeof parseExecutionBudgetGrantRequest;
  canonicalJson: typeof canonicalJson;
  recreateProviderInvocationRequest: typeof recreateProviderInvocationRequest;
  digestText: typeof digestText;
  canonicalExecutionBudgetGrantRequest: typeof canonicalExecutionBudgetGrantRequest;
  readPrivateCanonicalJson: typeof readPrivateCanonicalJson;
  grantMismatch: typeof grantMismatch;
  path: typeof path;
  privatePathExists: typeof privatePathExists;
  createPrivateCanonicalJson: typeof createPrivateCanonicalJson;
  writePrivateCanonicalJsonAtomic: typeof writePrivateCanonicalJsonAtomic;
};
export type ExecutionReplacementRecordsBindingsTypes = {
  ExecutionReplacementRequestBinding: ExecutionReplacementRequestBinding;
  ExecutionReplacementTransaction: ExecutionReplacementTransaction;
  ExecutionBudgetGrantRequest: ExecutionBudgetGrantRequest;
  ExecutionBudgetConsumeReceipt: ExecutionBudgetConsumeReceipt;
  InvestigationRuntimePaths: InvestigationRuntimePaths;
  ExecutionReplacementPhase: ExecutionReplacementPhase;
  recreateProviderInvocationRequest: typeof recreateProviderInvocationRequest;
};

const {
  createRequestBinding,
  createTransaction,
  readPersistedRequest,
  readRequestBinding,
  replacementRequestPath,
  replacementRequestBindingPath,
  replacementTransactionPath,
  readTransactionIfPresent,
  writeTransaction,
  advanceTransaction,
  assertReceipt,
  assertTransactionIdentity,
} = createExecutionReplacementRecords(() => ({
  digestCanonical,
  isRecord,
  hasExactKeys,
  isDigest,
  isProviderDigest,
  isIdentity,
  replacementUnsafe,
  isUuid,
  isTimestamp,
  parseExecutionBudgetGrantRequest,
  canonicalJson,
  recreateProviderInvocationRequest,
  digestText,
  canonicalExecutionBudgetGrantRequest,
  readPrivateCanonicalJson,
  grantMismatch,
  path,
  privatePathExists,
  createPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
}));

export type ExecutionReplacementPublicationBindings = {
  inspectExecutionBudgetGrantAuthorization: typeof inspectExecutionBudgetGrantAuthorization;
  assertActiveTaskMandateBindingUnderLifecycleLock: TaskMandateActiveBinding['assertActiveTaskMandateBindingUnderLifecycleLock'];
  parseMaintainerPolicy: typeof parseMaintainerPolicy;
  runGit: typeof runGit;
  consumeExecutionBudgetGrant: typeof consumeExecutionBudgetGrant;
  SimulatedExecutionReplacementCrash: typeof SimulatedExecutionReplacementCrash;
  assertReceipt: typeof assertReceipt;
  createTransaction: typeof createTransaction;
  writeTransaction: typeof writeTransaction;
  replacementTransactionPath: typeof replacementTransactionPath;
  loadInvestigationRuntimeContext: typeof loadInvestigationRuntimeContext;
  readProviderInvocation: typeof readProviderInvocation;
  replacementNotGrantable: typeof replacementNotGrantable;
  completeInterruptedPlanReviewReplacement: ProposeOperations['completeInterruptedPlanReviewReplacement'];
  getProposeStatus: ProposeOperations['getProposeStatus'];
  createProviderRetryEnvelope: ProposeOperations['createProviderRetryEnvelope'];
  createPlanReviewRetryEnvelope: ProposeOperations['createPlanReviewRetryEnvelope'];
  resumePropose: ProposeOperations['resumePropose'];
  providerInvocationExists: typeof providerInvocationExists;
  replacementStale: typeof replacementStale;
  readProviderInvocationRequest: typeof readProviderInvocationRequest;
  canonicalJson: typeof canonicalJson;
  mergeExactChanges: typeof mergeExactChanges;
  createExecutionBudgetGrantRequest: typeof createExecutionBudgetGrantRequest;
  deterministicUuid: typeof deterministicUuid;
  requireExecutionJobMandateBinding: typeof requireExecutionJobMandateBinding;
  replacementRationale: typeof replacementRationale;
  canonicalExecutionBudgetGrantRequest: typeof canonicalExecutionBudgetGrantRequest;
  inspectExecutionJob: typeof inspectExecutionJob;
  readPersistedRequest: typeof readPersistedRequest;
  readRequestBinding: typeof readRequestBinding;
  loadAiAdapterPolicy: typeof loadAiAdapterPolicy;
  replacementTimeout: typeof replacementTimeout;
  createProviderInvocationRequest: typeof createProviderInvocationRequest;
  digestCanonical: typeof digestCanonical;
  digestText: typeof digestText;
  grantMismatch: typeof grantMismatch;
};
export type ExecutionReplacementPublicationBindingsTypes = {
  InvestigationRuntimePaths: InvestigationRuntimePaths;
  ExecutionReplacementTransaction: ExecutionReplacementTransaction;
  ExecuteGrantedReplacementOptions: ExecuteGrantedReplacementOptions;
  ConsumedRoleReplayPort: ConsumedRoleReplayPort;
  ExecutionBudgetGrantRequest: ExecutionBudgetGrantRequest;
  inspectExecutionJob: typeof inspectExecutionJob;
};

function createReplacementPublication(
  propose: ExecutionReplacementProposePort,
) {
  return createExecutionReplacementPublication(() => ({
    ...propose,
    inspectExecutionBudgetGrantAuthorization,
    assertActiveTaskMandateBindingUnderLifecycleLock:
      propose.taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock,
    parseMaintainerPolicy,
    runGit,
    consumeExecutionBudgetGrant,
    SimulatedExecutionReplacementCrash,
    assertReceipt,
    createTransaction,
    writeTransaction,
    replacementTransactionPath,
    loadInvestigationRuntimeContext,
    readProviderInvocation,
    replacementNotGrantable,
    providerInvocationExists,
    replacementStale,
    readProviderInvocationRequest,
    canonicalJson,
    mergeExactChanges,
    createExecutionBudgetGrantRequest,
    deterministicUuid,
    requireExecutionJobMandateBinding,
    replacementRationale,
    canonicalExecutionBudgetGrantRequest,
    inspectExecutionJob,
    readPersistedRequest,
    readRequestBinding,
    loadAiAdapterPolicy,
    replacementTimeout,
    createProviderInvocationRequest,
    digestCanonical,
    digestText,
    grantMismatch,
  }));
}
