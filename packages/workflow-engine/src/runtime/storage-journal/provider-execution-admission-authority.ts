/**
 * Authenticates provider result admission against durable execution and
 * context evidence.
 *
 * Invariants:
 * - Admission authority must match its acceptance binding and canonical
 *   execution state.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertAttemptRecord,
  assertAttemptResult,
  assertJobRecord,
  assertWorkflowRecord,
  type AttemptRecord,
  type AttemptResult,
  type JobRecord,
  type WorkflowRecord,
} from '../../modules/provider-orchestration/execution-core.ts';
import type { ProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import { assertProviderInvocationAcceptanceBinding } from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import type { InvestigationRuntimePaths } from '../paths/runtime-paths.ts';

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_PROVIDER_ATTEMPTS = 1_000;

export const MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES =
  16 * 1_024 * 1_024;

export type ProviderExecutionAdmissionReceiptRequirement =
  ProviderInvocationAcceptanceBinding['receiptRequirement'];

export type ProviderExecutionAdmissionAuthority = Readonly<{
  schemaVersion: 1;
  kind: 'provider-execution-admission-authority.v1';
  acceptanceBindingDigest: string;
  executionStateDigest: string;
  receiptRequirement: ProviderExecutionAdmissionReceiptRequirement;
  acceptanceBinding: ProviderInvocationAcceptanceBinding;
  executionState: DurableExecutionAdmissionState;
  authorityDigest: string;
}>;

type ExecutionReconciliationReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-execution-reconciliation.v1';
  receiptId: string;
  jobId: string;
  triggerInvocationId: string;
  expectedExecutionRevision: number;
  expectedInvocationRevision: number;
  resultingExecutionRevision: number;
  beforeStateDigest: string;
  afterProjectionDigest: string;
  acceptedAttemptId: string | null;
  reconciledInvocationIds: string[];
  recordedAt: string;
}>;

export type DurableExecutionAdmissionState = Readonly<{
  schemaVersion: 1;
  revision: number;
  workflow: WorkflowRecord;
  job: JobRecord;
  attempts: AttemptRecord[];
  results: AttemptResult[];
  reconciliationReceipts: ExecutionReconciliationReceipt[];
  invocationProjection: {
    kind: 'provider-invocation-projection.v1';
    completeHistory: boolean;
    invocations: Array<{
      invocationId: string;
      invocationRevision: number;
      attemptId: string;
    }>;
  };
}>;

/**
 * A leaf-only address formula. The binding digest commits every acceptance
 * identity field and its execution-state digest; the latter commits the exact
 * canonical DurableExecutionJobState bytes.
 */
export function providerExecutionAdmissionAuthorityDigest(
  bindingInput: ProviderInvocationAcceptanceBinding,
): string {
  const binding = assertProviderInvocationAcceptanceBinding(
    bindingInput,
    invalidAdmissionAuthority,
  );
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-execution-admission-authority-address.v1',
      acceptanceBindingDigest: binding.bindingDigest,
      executionStateDigest: binding.executionStateDigest,
    }),
  );
}

export function providerExecutionAdmissionAuthorityPath(
  paths: InvestigationRuntimePaths,
  bindingInput: ProviderInvocationAcceptanceBinding,
): string {
  return path.join(
    paths.root,
    'execution',
    'admission-authorities',
    `${providerExecutionAdmissionAuthorityDigest(bindingInput)}.json`,
  );
}

export function createProviderExecutionAdmissionAuthority(
  bindingInput: ProviderInvocationAcceptanceBinding,
  executionStateInput: unknown,
  makeError: () => Error = invalidAdmissionAuthority,
): ProviderExecutionAdmissionAuthority {
  let binding: ProviderInvocationAcceptanceBinding;
  try {
    binding = assertProviderInvocationAcceptanceBinding(
      bindingInput,
      makeError,
    );
  } catch {
    throw makeError();
  }
  const executionState = assertDurableExecutionAdmissionState(
    executionStateInput,
    makeError,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-execution-admission-authority.v1' as const,
    acceptanceBindingDigest: binding.bindingDigest,
    executionStateDigest: binding.executionStateDigest,
    receiptRequirement: binding.receiptRequirement,
    acceptanceBinding: binding,
    executionState,
  };
  return assertProviderExecutionAdmissionAuthority(
    {
      ...body,
      authorityDigest: authorityDigest(body),
    },
    makeError,
  );
}

export function assertProviderExecutionAdmissionAuthority(
  value: unknown,
  makeError: () => Error = invalidAdmissionAuthority,
): ProviderExecutionAdmissionAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'acceptanceBindingDigest',
      'executionStateDigest',
      'receiptRequirement',
      'acceptanceBinding',
      'executionState',
      'authorityDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-execution-admission-authority.v1' ||
    !isDigest(value.acceptanceBindingDigest) ||
    !isDigest(value.executionStateDigest) ||
    (value.receiptRequirement !== 'schema-v4' &&
      value.receiptRequirement !== 'synchronous-no-activity') ||
    !isDigest(value.authorityDigest)
  ) {
    throw makeError();
  }
  let acceptanceBinding: ProviderInvocationAcceptanceBinding;
  let executionState: DurableExecutionAdmissionState;
  try {
    acceptanceBinding = assertProviderInvocationAcceptanceBinding(
      value.acceptanceBinding,
      makeError,
    );
    executionState = assertDurableExecutionAdmissionState(
      value.executionState,
      makeError,
    );
  } catch {
    throw makeError();
  }
  const attempt = executionState.attempts.find(
    ({ attemptId }) => attemptId === acceptanceBinding.executionAttemptId,
  );
  const contextManifest = acceptanceBinding.context.manifest;
  const contextInputItems = contextManifest.items.filter(
    ({ identity }) => identity === 'provider-input-manifest',
  );
  const {
    schemaVersion: _contextSchemaVersion,
    kind: _contextKind,
    contextDigest: _contextDigest,
    ...contextIdentity
  } = contextManifest;
  const repairAttempt = attempt?.retryMode === 'repair';
  const boundRepairAuthority =
    acceptanceBinding.repair.lineageDigest !== null &&
    acceptanceBinding.repair.evidencePath !== null &&
    acceptanceBinding.repair.evidenceDigest !== null;
  const body = {
    schemaVersion: 1 as const,
    kind: 'provider-execution-admission-authority.v1' as const,
    acceptanceBindingDigest: value.acceptanceBindingDigest,
    executionStateDigest: value.executionStateDigest,
    receiptRequirement: acceptanceBinding.receiptRequirement,
    acceptanceBinding,
    executionState,
  };
  // Prompt contexts and execution Jobs are separate workflow namespaces. A
  // changed manifest advances the purpose-scoped prompt context, while the
  // fresh manifest-addressed Job starts its own epoch and contract sequence.
  // Their shared authority is the exact provider-input-manifest digest below,
  // not coincidentally equal sequence numbers.
  if (
    value.acceptanceBindingDigest !== acceptanceBinding.bindingDigest ||
    value.receiptRequirement !== acceptanceBinding.receiptRequirement ||
    value.executionStateDigest !== acceptanceBinding.executionStateDigest ||
    value.executionStateDigest !== sha256(canonicalJson(executionState)) ||
    value.authorityDigest !== authorityDigest(body) ||
    executionState.revision !== acceptanceBinding.executionRevision ||
    executionState.workflow.workflowId !== acceptanceBinding.ownerWorkflowId ||
    executionState.job.jobId !== acceptanceBinding.executionJobId ||
    executionState.job.acceptedAttemptId !== null ||
    attempt === undefined ||
    attempt.status !== 'leased' ||
    attempt.lease === null ||
    attempt.leaseGeneration !== acceptanceBinding.leaseGeneration ||
    attempt.lease.generation !== acceptanceBinding.leaseGeneration ||
    attempt.providerInvocation?.invocationId !==
      acceptanceBinding.invocationId ||
    attempt.providerInvocation.invocationRevision !==
      acceptanceBinding.invocationRevision ||
    acceptanceBinding.context.purpose !== executionState.job.stage ||
    acceptanceBinding.context.contextDigest !==
      `sha256:${sha256(canonicalJson(contextIdentity))}` ||
    contextManifest.items.length !== 1 ||
    contextInputItems.length !== 1 ||
    executionState.job.contextDigest !== contextInputItems[0]!.digest ||
    contextInputItems[0]!.digest !==
      executionState.job.semanticSpec.inputDigest ||
    contextInputItems[0]!.digest !== attempt.inputDigest ||
    repairAttempt !== boundRepairAuthority ||
    repairAttempt !== (attempt.repairContext !== null)
  ) {
    throw makeError();
  }
  const authority = deepFreeze({
    ...body,
    authorityDigest: value.authorityDigest,
  });
  if (
    Buffer.byteLength(`${canonicalJson(authority)}\n`, 'utf8') >
    MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES
  ) {
    throw makeError();
  }
  return authority;
}

export function assertDurableExecutionAdmissionState(
  value: unknown,
  makeError: () => Error,
): DurableExecutionAdmissionState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attempts',
      'job',
      'invocationProjection',
      'reconciliationReceipts',
      'results',
      'revision',
      'schemaVersion',
      'workflow',
    ]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1 ||
    value.attempts.length > MAX_PROVIDER_ATTEMPTS ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.reconciliationReceipts) ||
    !isRecord(value.invocationProjection) ||
    !hasExactKeys(value.invocationProjection, [
      'completeHistory',
      'invocations',
      'kind',
    ]) ||
    value.invocationProjection.kind !== 'provider-invocation-projection.v1' ||
    typeof value.invocationProjection.completeHistory !== 'boolean' ||
    !Array.isArray(value.invocationProjection.invocations)
  ) {
    throw makeError();
  }
  let workflow: WorkflowRecord;
  let job: JobRecord;
  let attempts: AttemptRecord[];
  let results: AttemptResult[];
  let reconciliationReceipts: ExecutionReconciliationReceipt[];
  try {
    workflow = assertWorkflowRecord(value.workflow);
    job = assertJobRecord(value.job);
    attempts = value.attempts.map(assertAttemptRecord);
    results = value.results.map(assertAttemptResult);
    reconciliationReceipts = value.reconciliationReceipts.map((receipt) =>
      assertExecutionReconciliationReceipt(receipt, job.jobId, makeError),
    );
  } catch {
    throw makeError();
  }
  if (
    job.workflowId !== workflow.workflowId ||
    job.epoch !== workflow.currentEpoch ||
    job.contextDigest !== workflow.contextDigest ||
    job.attemptCount !== attempts.at(-1)!.attemptNumber ||
    value.invocationProjection.invocations.length !== attempts.length
  ) {
    throw makeError();
  }
  const attemptIds = new Set<string>();
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    const source = value.invocationProjection.invocations[index];
    if (
      attemptIds.has(attempt.attemptId) ||
      (index > 0 &&
        attempt.attemptNumber <= attempts[index - 1]!.attemptNumber) ||
      attempt.jobId !== job.jobId ||
      attempt.workflowId !== workflow.workflowId ||
      attempt.epoch !== job.epoch ||
      attempt.contextDigest !== job.contextDigest ||
      attempt.retryOf !==
        (index > 0 &&
        attempt.attemptNumber === attempts[index - 1]!.attemptNumber + 1
          ? attempts[index - 1]!.attemptId
          : null) ||
      !isRecord(source) ||
      !hasExactKeys(source, [
        'attemptId',
        'invocationId',
        'invocationRevision',
      ]) ||
      source.attemptId !== attempt.attemptId ||
      source.invocationId !== attempt.providerInvocation?.invocationId ||
      source.invocationRevision !==
        attempt.providerInvocation?.invocationRevision ||
      !Number.isSafeInteger(source.invocationRevision) ||
      (source.invocationRevision as number) < 0
    ) {
      throw makeError();
    }
    attemptIds.add(attempt.attemptId);
  }
  const resultAttempts = new Set<string>();
  let acceptedResult: AttemptResult | null = null;
  let priorAttemptNumber = 0;
  for (const result of results) {
    const attempt = attempts.find(
      ({ attemptId }) => attemptId === result.attemptId,
    );
    if (
      attempt === undefined ||
      resultAttempts.has(result.attemptId) ||
      result.workflowId !== workflow.workflowId ||
      result.epoch !== workflow.currentEpoch ||
      result.contextDigest !== workflow.contextDigest ||
      result.jobId !== job.jobId ||
      attempt.attemptNumber <= priorAttemptNumber ||
      (result.acceptance === 'accepted' && attempt.status !== 'succeeded') ||
      (result.acceptance === 'late-duplicate' &&
        attempt.status !== 'late-duplicate') ||
      (result.acceptance === 'stale' && attempt.status !== 'stale')
    ) {
      throw makeError();
    }
    if (result.acceptance === 'accepted') {
      if (acceptedResult !== null) throw makeError();
      acceptedResult = result;
    }
    resultAttempts.add(result.attemptId);
    priorAttemptNumber = attempt.attemptNumber;
  }
  for (const attempt of attempts) {
    if (
      ['succeeded', 'late-duplicate'].includes(attempt.status) !==
      resultAttempts.has(attempt.attemptId)
    ) {
      throw makeError();
    }
  }
  if (
    reconciliationReceipts.some(
      (receipt, index) =>
        receipt.resultingExecutionRevision > (value.revision as number) ||
        (index > 0 &&
          receipt.receiptId <= reconciliationReceipts[index - 1]!.receiptId),
    ) ||
    value.invocationProjection.completeHistory !==
      attempts.every(
        ({ attemptNumber }, index) => attemptNumber === index + 1,
      ) ||
    (job.acceptedAttemptId === null) !== (acceptedResult === null) ||
    (acceptedResult !== null &&
      acceptedResult.attemptId !== job.acceptedAttemptId)
  ) {
    throw makeError();
  }
  return deepFreeze({
    schemaVersion: 1,
    revision: value.revision as number,
    workflow,
    job,
    attempts,
    results,
    reconciliationReceipts,
    invocationProjection: {
      kind: 'provider-invocation-projection.v1',
      completeHistory: value.invocationProjection.completeHistory,
      invocations: value.invocationProjection.invocations.map((source) => ({
        invocationId: String((source as Record<string, unknown>).invocationId),
        invocationRevision: Number(
          (source as Record<string, unknown>).invocationRevision,
        ),
        attemptId: String((source as Record<string, unknown>).attemptId),
      })),
    },
  });
}

function assertExecutionReconciliationReceipt(
  value: unknown,
  expectedJobId: string,
  makeError: () => Error,
): ExecutionReconciliationReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'acceptedAttemptId',
      'afterProjectionDigest',
      'beforeStateDigest',
      'expectedExecutionRevision',
      'expectedInvocationRevision',
      'jobId',
      'kind',
      'receiptId',
      'reconciledInvocationIds',
      'recordedAt',
      'resultingExecutionRevision',
      'schemaVersion',
      'triggerInvocationId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-execution-reconciliation.v1' ||
    value.jobId !== expectedJobId ||
    typeof value.receiptId !== 'string' ||
    !PREFIXED_DIGEST.test(value.receiptId) ||
    typeof value.triggerInvocationId !== 'string' ||
    !IDENTIFIER.test(value.triggerInvocationId) ||
    !Number.isSafeInteger(value.expectedExecutionRevision) ||
    (value.expectedExecutionRevision as number) < 0 ||
    !Number.isSafeInteger(value.expectedInvocationRevision) ||
    (value.expectedInvocationRevision as number) < 0 ||
    !Number.isSafeInteger(value.resultingExecutionRevision) ||
    value.resultingExecutionRevision !==
      (value.expectedExecutionRevision as number) + 1 ||
    typeof value.beforeStateDigest !== 'string' ||
    !PREFIXED_DIGEST.test(value.beforeStateDigest) ||
    typeof value.afterProjectionDigest !== 'string' ||
    !PREFIXED_DIGEST.test(value.afterProjectionDigest) ||
    (value.acceptedAttemptId !== null &&
      (typeof value.acceptedAttemptId !== 'string' ||
        !IDENTIFIER.test(value.acceptedAttemptId))) ||
    !Array.isArray(value.reconciledInvocationIds) ||
    value.reconciledInvocationIds.some(
      (invocationId) =>
        typeof invocationId !== 'string' || !IDENTIFIER.test(invocationId),
    ) ||
    canonicalJson(value.reconciledInvocationIds) !==
      canonicalJson(
        [...new Set(value.reconciledInvocationIds as string[])].sort(),
      ) ||
    !isExactTimestamp(value.recordedAt)
  ) {
    throw makeError();
  }
  const expectedReceiptId = `sha256:${sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-execution-reconciliation-request.v1',
      jobId: expectedJobId,
      triggerInvocationId: value.triggerInvocationId,
      expectedExecutionRevision: value.expectedExecutionRevision,
      expectedInvocationRevision: value.expectedInvocationRevision,
    }),
  )}`;
  if (value.receiptId !== expectedReceiptId) throw makeError();
  return deepFreeze(structuredClone(value) as ExecutionReconciliationReceipt);
}

function authorityDigest(
  value: Omit<ProviderExecutionAdmissionAuthority, 'authorityDigest'>,
): string {
  return sha256(
    `workflow.provider-execution-admission-authority.v1\n${canonicalJson(value)}`,
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isExactTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function invalidAdmissionAuthority(): TypeError {
  return new TypeError('Provider execution admission authority is invalid.');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
