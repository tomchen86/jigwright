/** Checks pure timeout authority binding without a repository or durable Grant store. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createExecutionBudgetGrantRequest,
  canonicalExecutionBudgetGrantRequest,
  type ExecutionBudgetConsumeReceipt,
} from '../src/modules/authority/execution-governance-grant-contracts.ts';
import {
  createProviderExecutionBudgetAuthority,
  validateProviderExecutionBudgetAuthority,
} from '../src/modules/provider-orchestration/provider-execution-budget-authority.ts';

const digest = (value: string) =>
  `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const grantId = '11111111-1111-4111-8111-111111111111';
const mandateBinding = {
  schemaVersion: 1 as const,
  mandateTaskId: 'test-task',
  mandateId: '22222222-2222-4222-8222-222222222222',
  mandateDigest: 'a'.repeat(64),
  changeId: 'retry-test',
  externalAuditRoot: '/unused-audit-root',
};
const request = {
  invocationId: 'invocation-replacement',
  policyDigest: 'b'.repeat(64),
  limits: { timeoutMs: 600_000, aggregateOutputBytes: 1_024 },
};
const basePolicy = {
  digest: request.policyDigest,
  policy: { limits: { timeoutMs: 300_000 } },
};
const grantRequest = createExecutionBudgetGrantRequest({
  requestId: '33333333-3333-4333-8333-333333333333',
  workflowId: 'investigation-test',
  epoch: 1,
  jobId: 'job-test',
  mandateBinding,
  requestedChanges: [
    { path: '/timeoutMs', from: 300_000, to: 600_000 },
    { path: '/providerPolicy/limits/timeoutMs', from: 300_000, to: 600_000 },
  ],
  rationale: 'Retry one failed Attempt with the exact extended timeout.',
  expiresAfterAttempts: 1,
  createdAt: new Date('2026-08-03T08:00:00.000Z'),
});
function receipt(
  overrides: Partial<Omit<ExecutionBudgetConsumeReceipt, 'receiptId'>> = {},
): ExecutionBudgetConsumeReceipt {
  const core = {
    schemaVersion: 1 as const,
    kind: 'execution-budget-consume-receipt' as const,
    grantId,
    requestDigest: digest(canonicalExecutionBudgetGrantRequest(grantRequest)),
    workflowId: grantRequest.workflowId,
    epoch: grantRequest.epoch,
    jobId: grantRequest.jobId,
    mandateBinding,
    attemptId: `attempt-provider-${request.invocationId}`,
    useNumber: 1,
    remainingUses: 0,
    consumedAt: '2026-08-03T08:01:00.000Z',
    ...overrides,
  };
  return { ...core, receiptId: digest(canonicalJson(core)) };
}
const invalid = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  error.code === 'PROVIDER_EXECUTION_BUDGET_AUTHORITY_INVALID';

test('pure timeout authority preserves canonical receipt and authority digests', () => {
  const input = { grantId, grantRequest, receipt: receipt() };
  const authority = createProviderExecutionBudgetAuthority(
    request,
    basePolicy,
    input,
  );
  assert.equal(
    authority.authorityDigest,
    digest(
      canonicalJson({
        schemaVersion: 1,
        kind: 'provider-execution-budget-authority',
        ...input,
      }),
    ),
  );
  assert.deepEqual(
    validateProviderExecutionBudgetAuthority(request, basePolicy, authority),
    authority,
  );
  assert.equal(Object.isFrozen(authority.receipt), true);
});

test('pure timeout authority rejects a correctly rehashed receipt for any other binding', () => {
  const mutations: Partial<Omit<ExecutionBudgetConsumeReceipt, 'receiptId'>>[] =
    [
      { grantId: '44444444-4444-4444-8444-444444444444' },
      { workflowId: 'investigation-other' },
      { epoch: 2 },
      { jobId: 'job-other' },
      { attemptId: 'attempt-provider-other' },
      { requestDigest: `sha256:${'c'.repeat(64)}` },
      { mandateBinding: { ...mandateBinding, mandateDigest: 'd'.repeat(64) } },
      { useNumber: 2 },
      { remainingUses: 1 },
    ];
  for (const mutation of mutations) {
    assert.throws(
      () =>
        createProviderExecutionBudgetAuthority(request, basePolicy, {
          grantId,
          grantRequest,
          receipt: receipt(mutation),
        }),
      invalid,
      JSON.stringify(mutation),
    );
  }
  const authority = createProviderExecutionBudgetAuthority(
    request,
    basePolicy,
    { grantId, grantRequest, receipt: receipt() },
  );
  assert.throws(
    () =>
      validateProviderExecutionBudgetAuthority(request, basePolicy, {
        ...authority,
        authorityDigest: `sha256:${'0'.repeat(64)}`,
      }),
    invalid,
  );
  assert.throws(
    () =>
      createProviderExecutionBudgetAuthority(
        request,
        { ...basePolicy, digest: 'e'.repeat(64) },
        { grantId, grantRequest, receipt: receipt() },
      ),
    invalid,
  );
  assert.throws(
    () =>
      createProviderExecutionBudgetAuthority(request, basePolicy, {
        grantId,
        grantRequest,
        receipt: { ...receipt(), receiptId: `sha256:${'0'.repeat(64)}` },
      }),
    invalid,
  );
});
