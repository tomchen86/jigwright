/** Pure execution-budget Grant binding checks and record transitions. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from './task-mandate-contract.ts';
import { digest } from './execution-governance-values.ts';
import {
  type ExecutionBudgetGrantEnvelope,
  type ExecutionBudgetGrantRequest,
  type ExecutionBudgetGrantRecord,
  type ExecutionBudgetGrantInspection,
  type ExecutionBudgetGrantPayload,
  type ExecutionBudgetConsumeInput,
  type ExecutionBudgetRevocationInput,
  type ExecutionBudgetConsumeReceipt,
  assertExecutionGrantMandateBinding,
  validateExecutionBudgetGrantRequest,
  canonicalExecutionBudgetGrantRequest,
  validateExecutionBudgetConsumeReceipt,
  invalidGrant,
  invalidGrantRequest,
  unsafeGrantStore,
} from './execution-governance-grant-contracts.ts';

export function inspectionFromRecord(
  record: ExecutionBudgetGrantRecord,
): ExecutionBudgetGrantInspection {
  const inspection: ExecutionBudgetGrantInspection = {
    state: record.state,
    remainingUses: record.remainingUses,
    receipts: record.receipts.map((receipt) => ({ ...receipt })),
  };
  if (record.state === 'revoked') {
    inspection.revokedAt = record.revokedAt!;
    inspection.revocationReason = record.revocationReason!;
  }
  return inspection;
}

export function revokedInspectionFromRecord(
  record: ExecutionBudgetGrantRecord,
): ExecutionBudgetGrantInspection & {
  state: 'revoked';
  revokedAt: string;
  revocationReason: string;
} {
  if (
    record.state !== 'revoked' ||
    record.revokedAt == null ||
    record.revocationReason == null
  ) {
    throw unsafeGrantStore();
  }
  return {
    ...inspectionFromRecord(record),
    state: 'revoked',
    revokedAt: record.revokedAt,
    revocationReason: record.revocationReason,
  };
}

export function requireAuditedExecutionBudgetGrant(
  envelope: ExecutionBudgetGrantEnvelope,
  input: {
    request: ExecutionBudgetGrantRequest | undefined;
    mandateBinding: TaskMandateBinding | undefined;
    audit: unknown;
  },
  validateAudit: (value: unknown) => unknown,
): TaskMandateBinding {
  if (
    input.request === undefined ||
    input.mandateBinding === undefined ||
    input.audit === undefined
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_AUDIT_REQUIRED',
      'Execution-budget authority requires its exact request and external audit context.',
      ExitCode.guard,
    );
  }
  validateExecutionBudgetGrantRequest(input.request);
  const payloadBinding = assertExecutionGrantMandateBinding(
    envelope.payload.mandateBinding,
    invalidGrant,
  );
  const requestBinding = assertExecutionGrantMandateBinding(
    input.request.mandateBinding,
    invalidGrantRequest,
  );
  const binding = assertExecutionGrantMandateBinding(
    input.mandateBinding,
    invalidGrant,
  );
  validateAudit(input.audit);
  if (
    canonicalJson(binding) !== canonicalJson(payloadBinding) ||
    canonicalJson(binding) !== canonicalJson(requestBinding) ||
    envelope.payload.requestDigest !==
      digest(canonicalExecutionBudgetGrantRequest(input.request)) ||
    envelope.payload.workflowId !== input.request.workflowId ||
    envelope.payload.epoch !== input.request.epoch ||
    envelope.payload.jobId !== input.request.jobId ||
    canonicalJson(envelope.payload.allowedChanges) !==
      canonicalJson(input.request.requestedChanges)
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
      'Execution-budget grant, request, and Task Mandate bindings do not match exactly.',
      ExitCode.guard,
    );
  }
  return binding;
}

export function requireCurrentExecutionBudgetGrantBinding(
  payload: ExecutionBudgetGrantPayload,
  requested: TaskMandateBinding,
): TaskMandateBinding {
  const binding = requireStoredExecutionBudgetGrantBinding(payload);
  if (canonicalJson(binding) !== canonicalJson(requested)) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
      'Execution-budget grant does not match the exact Execution Job Task Mandate binding.',
      ExitCode.guard,
    );
  }
  return binding;
}

export function requireStoredExecutionBudgetGrantBinding(
  payload: ExecutionBudgetGrantPayload,
): TaskMandateBinding {
  return assertExecutionGrantMandateBinding(
    payload.mandateBinding,
    unsafeGrantStore,
  );
}

export function prepareExecutionBudgetGrantConsumption(
  record: ExecutionBudgetGrantRecord,
  payload: ExecutionBudgetGrantPayload,
  input: ExecutionBudgetConsumeInput,
  grantId: string,
  consumedAt: string,
  inputBinding: TaskMandateBinding,
) {
  const binding = requireCurrentExecutionBudgetGrantBinding(
    payload,
    inputBinding,
  );
  if (
    payload.workflowId !== input.workflowId ||
    payload.epoch !== input.epoch ||
    payload.jobId !== input.jobId
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
      'Execution-budget grant cannot be reused across a workflow epoch or job.',
      ExitCode.guard,
    );
  }
  if (payload.requestDigest !== input.requestDigest) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_REQUEST_MISMATCH',
      'Execution-budget grant is not bound to the expected GrantRequest.',
      ExitCode.guard,
    );
  }
  if (record.consumedAttemptIds.includes(input.attemptId)) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_ATTEMPT_REUSED',
      `Attempt ${input.attemptId} already consumed this grant.`,
      ExitCode.conflict,
    );
  }
  if (record.state === 'revoked') {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_REVOKED',
      `Execution-budget grant ${grantId} was revoked.`,
      ExitCode.guard,
    );
  }
  if (record.remainingUses < 1 || record.state === 'consumed') {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_EXHAUSTED',
      `Execution-budget grant ${grantId} has no remaining uses.`,
      ExitCode.guard,
    );
  }
  if (
    canonicalJson(input.requestedChanges) !==
    canonicalJson(payload.allowedChanges)
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_CHANGE_MISMATCH',
      'Execution-budget grant does not authorize the requested execution-policy change.',
      ExitCode.guard,
    );
  }
  const previousConsumedAt = record.receipts.at(-1)?.consumedAt;
  if (
    new Date(consumedAt).getTime() < new Date(payload.issuedAt).getTime() ||
    (previousConsumedAt !== undefined &&
      new Date(consumedAt).getTime() < new Date(previousConsumedAt).getTime())
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_TIME_INVALID',
      'Execution-budget grant use predates issuance or a prior use.',
      ExitCode.staleState,
    );
  }
  const receiptCore = {
    schemaVersion: 1 as const,
    kind: 'execution-budget-consume-receipt' as const,
    grantId,
    requestDigest: payload.requestDigest,
    workflowId: payload.workflowId,
    epoch: payload.epoch,
    jobId: payload.jobId,
    mandateBinding: binding,
    attemptId: input.attemptId,
    useNumber: record.receipts.length + 1,
    remainingUses: record.remainingUses - 1,
    consumedAt,
  };
  const receipt: ExecutionBudgetConsumeReceipt = {
    ...receiptCore,
    receiptId: digest(canonicalJson(receiptCore)),
  };
  validateExecutionBudgetConsumeReceipt(receipt, payload);
  const next: ExecutionBudgetGrantRecord = {
    ...record,
    schemaVersion: 3,
    receipts: [...record.receipts, receipt],
    consumedAttemptIds: [...record.consumedAttemptIds, input.attemptId],
    remainingUses: record.remainingUses - 1,
    state: record.remainingUses - 1 === 0 ? 'consumed' : 'active',
  };

  return { binding, receipt, next };
}

export function prepareExecutionBudgetGrantRevocation(
  record: ExecutionBudgetGrantRecord,
  input: ExecutionBudgetRevocationInput,
  grantId: string,
  revokedAt: string,
) {
  if (record.state === 'consumed') {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_ALREADY_CONSUMED',
      `Execution-budget grant ${grantId} was already fully consumed.`,
      ExitCode.guard,
    );
  }
  const latestAuthorityAt =
    record.receipts.at(-1)?.consumedAt ?? record.envelope.payload.issuedAt;
  if (new Date(revokedAt).getTime() < new Date(latestAuthorityAt).getTime()) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_TIME_INVALID',
      'Execution-budget grant revocation predates issuance or a prior use.',
      ExitCode.staleState,
    );
  }
  const revoked: ExecutionBudgetGrantRecord = {
    ...record,
    schemaVersion: 3,
    state: 'revoked',
    revokedAt,
    revocationReason: input.reason,
  };

  return revoked;
}
