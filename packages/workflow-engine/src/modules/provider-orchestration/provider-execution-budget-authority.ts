/**
 * Binds a provider timeout exception to its exact request and canonical receipt.
 *
 * Invariants:
 * - The receipt binds one replacement Attempt and exhausted single-use counters.
 * - Runtime independently verifies terminal consumption; these functions do not read stores.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  parseExecutionBudgetGrantRequest,
  type ExecutionBudgetConsumeReceipt,
  type ExecutionBudgetGrantRequest,
} from '../authority/execution-governance-grant-contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { ProviderInvocationRequest } from './provider-contracts.ts';
import { MAX_PROVIDER_LIMITS } from './provider-limits.ts';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProviderExecutionBudgetPolicy = Readonly<{
  digest: string;
  policy: { limits: { timeoutMs: number } };
}>;

export type ProviderExecutionGrantAuthorityInput = Readonly<{
  grantId: string;
  grantRequest: ExecutionBudgetGrantRequest;
  receipt: ExecutionBudgetConsumeReceipt;
}>;

export type ProviderExecutionBudgetAuthority = Readonly<{
  schemaVersion: 1;
  kind: 'provider-execution-budget-authority';
  grantId: string;
  grantRequest: ExecutionBudgetGrantRequest;
  receipt: ExecutionBudgetConsumeReceipt;
  authorityDigest: string;
}>;

/**
 * Bind a provider timeout above the repository policy ceiling to the exact
 * one-shot execution-budget request and its durable consume receipt. The base
 * policy remains the request's policyDigest authority; this object is only the
 * narrow per-Attempt exception.
 */
export function createProviderExecutionBudgetAuthority(
  request: Pick<
    ProviderInvocationRequest,
    'invocationId' | 'policyDigest' | 'limits'
  >,
  basePolicy: ProviderExecutionBudgetPolicy,
  input: ProviderExecutionGrantAuthorityInput,
): ProviderExecutionBudgetAuthority {
  const core = validateAuthorityCore(request, basePolicy, input);
  return deepFreeze({
    ...core,
    authorityDigest: digestCanonical(core),
  });
}

export function validateProviderExecutionBudgetAuthority(
  request: Pick<
    ProviderInvocationRequest,
    'invocationId' | 'policyDigest' | 'limits'
  >,
  basePolicy: ProviderExecutionBudgetPolicy,
  value: unknown,
): ProviderExecutionBudgetAuthority {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'authorityDigest',
      'grantId',
      'grantRequest',
      'kind',
      'receipt',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-execution-budget-authority' ||
    typeof value.authorityDigest !== 'string' ||
    !SHA256.test(value.authorityDigest)
  ) {
    throw invalidProviderExecutionBudgetAuthority();
  }
  const core = validateAuthorityCore(request, basePolicy, {
    grantId: value.grantId as string,
    grantRequest: value.grantRequest as ExecutionBudgetGrantRequest,
    receipt: value.receipt as ExecutionBudgetConsumeReceipt,
  });
  if (value.authorityDigest !== digestCanonical(core)) {
    throw invalidProviderExecutionBudgetAuthority();
  }
  return deepFreeze({ ...core, authorityDigest: value.authorityDigest });
}

function validateAuthorityCore(
  request: Pick<
    ProviderInvocationRequest,
    'invocationId' | 'policyDigest' | 'limits'
  >,
  basePolicy: ProviderExecutionBudgetPolicy,
  input: ProviderExecutionGrantAuthorityInput,
): Omit<ProviderExecutionBudgetAuthority, 'authorityDigest'> {
  if (
    request.policyDigest !== basePolicy.digest ||
    request.limits.timeoutMs <= basePolicy.policy.limits.timeoutMs ||
    request.limits.timeoutMs > MAX_PROVIDER_LIMITS.timeoutMs ||
    typeof input.grantId !== 'string' ||
    !UUID_V4.test(input.grantId)
  ) {
    throw invalidProviderExecutionBudgetAuthority();
  }
  let grantRequest: ExecutionBudgetGrantRequest;
  try {
    grantRequest = parseExecutionBudgetGrantRequest(
      canonicalExecutionBudgetGrantRequest(input.grantRequest),
    );
  } catch {
    throw invalidProviderExecutionBudgetAuthority();
  }
  const receipt = validateReceipt(input.receipt);
  const requestDigest = digestText(
    canonicalExecutionBudgetGrantRequest(grantRequest),
  );
  const timeoutChange = grantRequest.requestedChanges.find(
    ({ path }) => path === '/timeoutMs',
  );
  const ceilingChange = grantRequest.requestedChanges.find(
    ({ path }) => path === '/providerPolicy/limits/timeoutMs',
  );
  if (
    receipt.grantId !== input.grantId ||
    receipt.requestDigest !== requestDigest ||
    grantRequest.expiresAfterAttempts !== 1 ||
    receipt.workflowId !== grantRequest.workflowId ||
    receipt.epoch !== grantRequest.epoch ||
    receipt.jobId !== grantRequest.jobId ||
    receipt.attemptId !== `attempt-provider-${request.invocationId}` ||
    receipt.useNumber !== 1 ||
    receipt.remainingUses !== 0 ||
    grantRequest.mandateBinding === undefined ||
    canonicalJson(receipt.mandateBinding) !==
      canonicalJson(grantRequest.mandateBinding) ||
    timeoutChange === undefined ||
    ceilingChange === undefined ||
    canonicalJson(timeoutChange) !==
      canonicalJson({
        path: '/timeoutMs',
        from: timeoutChange.from,
        to: request.limits.timeoutMs,
      }) ||
    !Number.isSafeInteger(timeoutChange.from) ||
    (timeoutChange.from as number) >= request.limits.timeoutMs ||
    canonicalJson(ceilingChange) !==
      canonicalJson({
        path: '/providerPolicy/limits/timeoutMs',
        from: basePolicy.policy.limits.timeoutMs,
        to: request.limits.timeoutMs,
      })
  ) {
    throw invalidProviderExecutionBudgetAuthority();
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    kind: 'provider-execution-budget-authority' as const,
    grantId: input.grantId,
    grantRequest,
    receipt,
  });
}

function validateReceipt(value: unknown): ExecutionBudgetConsumeReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'attemptId',
      'consumedAt',
      'epoch',
      'grantId',
      'jobId',
      'kind',
      'mandateBinding',
      'receiptId',
      'remainingUses',
      'requestDigest',
      'schemaVersion',
      'useNumber',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-consume-receipt' ||
    typeof value.receiptId !== 'string' ||
    !SHA256.test(value.receiptId) ||
    typeof value.requestDigest !== 'string' ||
    !SHA256.test(value.requestDigest) ||
    typeof value.grantId !== 'string' ||
    !UUID_V4.test(value.grantId) ||
    typeof value.workflowId !== 'string' ||
    typeof value.jobId !== 'string' ||
    typeof value.attemptId !== 'string' ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 1 ||
    !Number.isSafeInteger(value.useNumber) ||
    (value.useNumber as number) < 1 ||
    !Number.isSafeInteger(value.remainingUses) ||
    (value.remainingUses as number) < 0 ||
    !isTimestamp(value.consumedAt)
  ) {
    throw invalidProviderExecutionBudgetAuthority();
  }
  const { receiptId, ...core } = value;
  if (receiptId !== digestText(canonicalJson(core))) {
    throw invalidProviderExecutionBudgetAuthority();
  }
  return deepFreeze(structuredClone(value) as ExecutionBudgetConsumeReceipt);
}

export function invalidProviderExecutionBudgetAuthority() {
  return workflowError(
    'PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID',
    'Provider timeout above the base policy ceiling requires the exact durable execution-budget receipt.',
    ExitCode.guard,
  );
}

function digestCanonical(value: unknown): string {
  return digestText(canonicalJson(value));
}

function digestText(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
