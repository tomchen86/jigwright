/**
 * Persist and validate each invocation's execution policy and retry accounting authority.
 *
 * Invariants:
 * - Policy snapshots retain their schema, canonical bytes, and exact request binding.
 * - Durable execution budget authority is checked before accepting stored policy.
 */

import path from 'node:path';
import {
  type LoadedAiAdapterPolicy,
  parseAiAdapterPolicyDocument,
  type AiAdapterRetryAccounting,
} from '../provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  privatePathExists,
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import {
  type ProviderExecutionGrantAuthorityInput,
  createProviderExecutionBudgetAuthority,
  validateProviderExecutionBudgetAuthority,
  assertDurableProviderExecutionBudgetAuthority as assertStoredProviderExecutionBudgetAuthority,
} from './provider-execution-policy-authority.ts';
import type { ProviderExecutionBudgetAuthority } from '../../modules/provider-orchestration/provider-execution-budget-authority.ts';
import { type ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { assertInvocationId } from '../../foundation/repository-path/repository-path.ts';
import type { ProviderExecutionPolicySnapshotCurrent } from '../../modules/provider-orchestration/provider-execution-policy-snapshot.ts';
import type {
  ProviderAttemptBudgetReservation,
  ProviderRetryAccountingSnapshot,
} from '../../modules/provider-orchestration/provider-retry-accounting.ts';
import { assertProviderRequest } from './provider-invocation-validation.ts';
import {
  providerExecutionPolicySnapshotUnsafe,
  providerExecutionPolicySnapshotMismatch,
  deepFreeze,
  isRecord,
  hasExactKeys,
  DIGEST,
  sha256,
  providerInvocationDirectory,
} from './provider-invocation-common.ts';

/**
 * Publish the exact validated policy bytes selected for one Attempt. The raw
 * document, rather than a reconstructed object, remains the digest authority so
 * the request cannot be rebound through whitespace or alternate JSON bytes.
 */
export function storeProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
  loadedInput: LoadedAiAdapterPolicy,
  executionGrantAuthorization?: ProviderExecutionGrantAuthorityInput,
): ProviderExecutionPolicySnapshotCurrent {
  const snapshot = createProviderExecutionPolicySnapshot(
    requestInput,
    loadedInput,
    executionGrantAuthorization,
  );
  return ensureProviderExecutionPolicySnapshotFromSnapshot(
    paths,
    requestInput,
    snapshot,
  );
}

export function createProviderExecutionPolicySnapshot(
  requestInput: ProviderInvocationRequest,
  loadedInput: LoadedAiAdapterPolicy,
  executionGrantAuthorization?: ProviderExecutionGrantAuthorityInput,
): ProviderExecutionPolicySnapshotCurrent {
  const request = assertProviderRequest(requestInput);
  let loaded: LoadedAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(loadedInput.document);
  } catch {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  if (
    loaded.digest !== loadedInput.digest ||
    canonicalJson(loaded.policy) !== canonicalJson(loadedInput.policy) ||
    request.policyDigest !== loaded.digest ||
    request.limits.aggregateOutputBytes >
      loaded.policy.limits.aggregateOutputBytes
  ) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  const authority =
    request.limits.timeoutMs > loaded.policy.limits.timeoutMs
      ? createProviderExecutionBudgetAuthority(
          request,
          loaded,
          executionGrantAuthorization ?? missingExecutionGrantAuthority(),
        )
      : null;
  const retryAccounting = structuredClone(loaded.policy.retryAccounting);
  const attemptReservation: ProviderAttemptBudgetReservation = Object.freeze({
    runtimeMs: request.limits.timeoutMs,
    providerCostMicros:
      retryAccounting.reservations[request.providerId].providerCostMicros,
    providerTokens:
      retryAccounting.reservations[request.providerId].providerTokens,
  });
  const accountingDigest = providerRetryAccountingDigest({
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    policyDigest: request.policyDigest,
    retryAccounting,
    attemptReservation,
  });
  const common = {
    kind: 'provider-execution-policy-snapshot',
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    policyDigest: request.policyDigest,
    policyDocument: loaded.document,
    retryAccounting,
    attemptReservation,
    accountingDigest,
  } as const;
  return deepFreeze(
    authority === null
      ? { schemaVersion: 2 as const, ...common }
      : { schemaVersion: 3 as const, ...common, authority },
  );
}

export function ensureProviderExecutionPolicySnapshotFromSnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
  snapshotInput: ProviderExecutionPolicySnapshotCurrent,
): ProviderExecutionPolicySnapshotCurrent {
  const request = assertProviderRequest(requestInput);
  const expected = validateProviderExecutionPolicySnapshot(
    request,
    snapshotInput,
  );
  if (expected.schemaVersion === 3) {
    assertDurableProviderExecutionBudgetAuthority(paths, expected.authority);
  }
  const snapshotPath = providerExecutionPolicySnapshotPath(
    paths,
    request.invocationId,
  );
  if (
    privatePathExists(
      paths,
      snapshotPath,
      providerExecutionPolicySnapshotUnsafe,
    )
  ) {
    const existing = readProviderExecutionPolicySnapshot(
      paths,
      request,
    ).snapshot;
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw providerExecutionPolicySnapshotMismatch();
    }
    return existing;
  }
  createPrivateCanonicalJson(
    paths,
    snapshotPath,
    expected,
    providerExecutionPolicySnapshotUnsafe,
    'PROVIDER_EXECUTION_POLICY_SNAPSHOT_CONFLICT',
  );
  return readProviderExecutionPolicySnapshot(paths, request).snapshot;
}

export function validateProviderExecutionPolicySnapshot(
  requestInput: ProviderInvocationRequest,
  snapshotInput: unknown,
): ProviderExecutionPolicySnapshotCurrent {
  const request = assertProviderRequest(requestInput);
  if (
    !isRecord(snapshotInput) ||
    ![2, 3].includes(snapshotInput.schemaVersion as number) ||
    !isProviderExecutionPolicySnapshotShape(snapshotInput)
  ) {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  let loaded: LoadedAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(snapshotInput.policyDocument);
  } catch {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  const expected = createProviderExecutionPolicySnapshot(
    request,
    loaded,
    snapshotInput.schemaVersion === 3
      ? validateProviderExecutionBudgetAuthority(
          request,
          loaded,
          snapshotInput.authority,
        )
      : undefined,
  );
  if (canonicalJson(expected) !== canonicalJson(snapshotInput)) {
    throw providerExecutionPolicySnapshotMismatch();
  }
  return expected;
}

/**
 * Recover a missing snapshot only from policy bytes that independently validate
 * to the request's exact digest. An existing snapshot remains the authority and
 * is validated without consulting possibly newer live policy bytes.
 */
export function ensureProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
  loadedInput: LoadedAiAdapterPolicy,
): ProviderExecutionPolicySnapshotCurrent {
  const request = assertProviderRequest(requestInput);
  const snapshotPath = providerExecutionPolicySnapshotPath(
    paths,
    request.invocationId,
  );
  if (
    privatePathExists(
      paths,
      snapshotPath,
      providerExecutionPolicySnapshotUnsafe,
    )
  ) {
    return readProviderExecutionPolicySnapshot(paths, request).snapshot;
  }
  return storeProviderExecutionPolicySnapshot(paths, request, loadedInput);
}

export function readProviderExecutionPolicySnapshot(
  paths: InvestigationRuntimePaths,
  requestInput: ProviderInvocationRequest,
): Readonly<{
  snapshot: ProviderExecutionPolicySnapshotCurrent;
  loaded: LoadedAiAdapterPolicy;
  accounting: ProviderRetryAccountingSnapshot;
}> {
  const request = assertProviderRequest(requestInput);
  let value: unknown;
  try {
    value = readPrivateCanonicalJson(
      paths,
      providerExecutionPolicySnapshotPath(paths, request.invocationId),
      providerExecutionPolicySnapshotUnsafe,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE'
    ) {
      throw error;
    }
    throw providerExecutionPolicySnapshotUnsafe();
  }
  if (!isRecord(value) || !isProviderExecutionPolicySnapshotShape(value)) {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  let loaded: LoadedAiAdapterPolicy;
  try {
    loaded = parseAiAdapterPolicyDocument(value.policyDocument);
  } catch {
    throw providerExecutionPolicySnapshotUnsafe();
  }
  const snapshot = validateProviderExecutionPolicySnapshot(request, value);
  if (snapshot.schemaVersion === 3) {
    assertDurableProviderExecutionBudgetAuthority(paths, snapshot.authority);
  }
  return Object.freeze({
    snapshot,
    loaded,
    accounting: deepFreeze({
      retryPolicy: structuredClone(loaded.policy.retryAccounting),
      attemptReservation: structuredClone(snapshot.attemptReservation),
      accountingDigest: snapshot.accountingDigest,
    }),
  });
}

function isProviderExecutionPolicySnapshotShape(
  value: Record<string, unknown>,
): value is ProviderExecutionPolicySnapshotCurrent {
  const common =
    value.kind === 'provider-execution-policy-snapshot' &&
    typeof value.invocationId === 'string' &&
    typeof value.requestDigest === 'string' &&
    typeof value.policyDigest === 'string' &&
    typeof value.policyDocument === 'string';
  if (!common) return false;
  const expectedKeys = [
    'accountingDigest',
    'attemptReservation',
    ...(value.schemaVersion === 3 ? ['authority'] : []),
    'invocationId',
    'kind',
    'policyDigest',
    'policyDocument',
    'requestDigest',
    'retryAccounting',
    'schemaVersion',
  ];
  return (
    (value.schemaVersion === 2 || value.schemaVersion === 3) &&
    hasExactKeys(value, expectedKeys) &&
    (value.schemaVersion !== 3 || isRecord(value.authority)) &&
    isRecord(value.retryAccounting) &&
    isProviderAttemptBudgetReservation(value.attemptReservation) &&
    typeof value.accountingDigest === 'string' &&
    DIGEST.test(value.accountingDigest)
  );
}

function assertDurableProviderExecutionBudgetAuthority(
  paths: InvestigationRuntimePaths,
  authority: ProviderExecutionBudgetAuthority,
): void {
  try {
    assertStoredProviderExecutionBudgetAuthority(paths.root, authority);
  } catch {
    throw providerExecutionPolicySnapshotMismatch();
  }
}

function missingExecutionGrantAuthority(): never {
  throw providerExecutionPolicySnapshotMismatch();
}

function isProviderAttemptBudgetReservation(
  value: unknown,
): value is ProviderAttemptBudgetReservation {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'providerCostMicros',
      'providerTokens',
      'runtimeMs',
    ]) &&
    Number.isSafeInteger(value.runtimeMs) &&
    (value.runtimeMs as number) > 0 &&
    Number.isSafeInteger(value.providerCostMicros) &&
    (value.providerCostMicros as number) > 0 &&
    Number.isSafeInteger(value.providerTokens) &&
    (value.providerTokens as number) > 0
  );
}

function providerRetryAccountingDigest(input: {
  invocationId: string;
  requestDigest: string;
  policyDigest: string;
  retryAccounting: AiAdapterRetryAccounting;
  attemptReservation: ProviderAttemptBudgetReservation;
}): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-retry-accounting-snapshot',
      ...input,
    }),
  );
}

export function providerExecutionPolicySnapshotPath(
  paths: InvestigationRuntimePaths,
  requestedInvocationId: string,
): string {
  return path.join(
    providerInvocationDirectory(
      paths,
      assertInvocationId(requestedInvocationId),
    ),
    'execution-policy.json',
  );
}
