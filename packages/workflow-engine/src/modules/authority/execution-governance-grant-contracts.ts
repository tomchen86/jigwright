/**
 * Defines strict execution-budget grant envelopes, usage records, and canonical signing bytes.
 *
 * Invariants:
 * - Grant identity and usage counters retain exact request and Task Mandate bindings.
 * - Canonical bytes, supported schemas, limits, and error codes remain unchanged.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from './task-mandate.ts';
import {
  type JsonValue,
  exactDate,
  parseDocument,
  normalizeInvalid,
  digest,
  isRecord,
  hasExactKeys,
  assertUuid,
  assertIdentity,
  assertPositiveInteger,
  assertReason,
  assertBoundedInteger,
  assertTimestamp,
  assertDigest,
  cloneJson,
  JSON_POINTER,
  assertJsonValue,
  UUID_V4,
} from './execution-governance-values.ts';

export const EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE =
  'HARNESS_EXECUTION_BUDGET_GRANT_V1';

const MAX_GRANT_USES = 16;

export type ExecutionBudgetChange = {
  path: string;
  from: JsonValue;
  to: JsonValue;
};

export type ExecutionBudgetGrantRequest = {
  schemaVersion: 1;
  kind: 'execution-budget-grant-request';
  requestId: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  mandateBinding: TaskMandateBinding;
  requestedChanges: ExecutionBudgetChange[];
  rationale: string;
  expiresAfterAttempts: number;
  createdAt: string;
};

export type GrantRequest = ExecutionBudgetGrantRequest;

export type ExecutionBudgetGrantPayload = {
  schemaVersion: 1;
  kind: 'execution-budget-grant.v1';
  grantId: string;
  requestDigest: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  mandateBinding: TaskMandateBinding;
  allowedChanges: ExecutionBudgetChange[];
  maxUses: number;
  issuedAt: string;
  issuer: string;
};

export type ExecutionBudgetGrantEnvelope = {
  payload: ExecutionBudgetGrantPayload;
  signature: string;
};

export type ExecutionBudgetConsumeReceipt = {
  schemaVersion: 1;
  kind: 'execution-budget-consume-receipt';
  receiptId: string;
  grantId: string;
  requestDigest: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  mandateBinding: TaskMandateBinding;
  attemptId: string;
  useNumber: number;
  remainingUses: number;
  consumedAt: string;
};

export type ExecutionBudgetGrantAuthorization = Readonly<{
  grantId: string;
  request: ExecutionBudgetGrantRequest;
  receipt: ExecutionBudgetConsumeReceipt;
}>;

export type ExecutionBudgetGrantRecord = {
  schemaVersion: 3;
  state: 'active' | 'consumed' | 'revoked';
  envelopeDigest: string;
  envelope: ExecutionBudgetGrantEnvelope;
  remainingUses: number;
  consumedAttemptIds: string[];
  receipts: ExecutionBudgetConsumeReceipt[];
  revokedAt: string | null;
  revocationReason: string | null;
};

export type ExecutionBudgetGrantInspection = {
  state: 'active' | 'consumed' | 'revoked';
  remainingUses: number;
  receipts: ExecutionBudgetConsumeReceipt[];
  revokedAt?: string;
  revocationReason?: string;
};

export type ExecutionBudgetGrantMetricsRecord = Readonly<{
  grantId: string;
  requestDigest: string;
  consumedAttemptIds: readonly string[];
}>;

export function createExecutionBudgetGrantRequest(input: {
  requestId: string;
  workflowId: string;
  epoch: number;
  jobId: string;
  mandateBinding: TaskMandateBinding;
  requestedChanges: ExecutionBudgetChange[];
  rationale: string;
  expiresAfterAttempts: number;
  createdAt: Date;
}): ExecutionBudgetGrantRequest {
  const request: ExecutionBudgetGrantRequest = {
    schemaVersion: 1,
    kind: 'execution-budget-grant-request',
    requestId: input.requestId,
    workflowId: input.workflowId,
    epoch: input.epoch,
    jobId: input.jobId,
    mandateBinding: assertExecutionGrantMandateBinding(
      input.mandateBinding,
      invalidGrantRequest,
    ),
    requestedChanges: sortChanges(input.requestedChanges, invalidGrantRequest),
    rationale: input.rationale,
    expiresAfterAttempts: input.expiresAfterAttempts,
    createdAt: exactDate(input.createdAt, 'EXECUTION_GRANT_REQUEST_INVALID'),
  };
  validateExecutionBudgetGrantRequest(request);
  return request;
}

export function canonicalExecutionBudgetGrantRequest(
  request: ExecutionBudgetGrantRequest,
): string {
  validateExecutionBudgetGrantRequest(request);
  return `${canonicalJson(request)}\n`;
}

export function parseExecutionBudgetGrantRequest(
  raw: string,
): ExecutionBudgetGrantRequest {
  try {
    const value = parseDocument(raw);
    validateExecutionBudgetGrantRequest(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'EXECUTION_GRANT_REQUEST_INVALID',
      'Execution-budget grant request is malformed.',
    );
  }
}

export function createExecutionBudgetGrantEnvelope(
  request: ExecutionBudgetGrantRequest,
  input: {
    grantId: string;
    issuedAt: Date;
    issuer: string;
    maxUses: number;
    signature: string;
  },
): ExecutionBudgetGrantEnvelope {
  validateExecutionBudgetGrantRequest(request);
  if (
    !Number.isSafeInteger(input.maxUses) ||
    input.maxUses < 1 ||
    input.maxUses > request.expiresAfterAttempts
  ) {
    throw invalidGrant(
      'Grant uses must be positive and no greater than the requested attempt bound.',
    );
  }
  const issuedAt = exactDate(input.issuedAt, 'EXECUTION_BUDGET_GRANT_INVALID');
  if (new Date(issuedAt).getTime() < new Date(request.createdAt).getTime()) {
    throw invalidGrant('Grant cannot be issued before its bound request.');
  }
  const payload: ExecutionBudgetGrantPayload = {
    schemaVersion: 1,
    kind: 'execution-budget-grant.v1',
    grantId: input.grantId,
    requestDigest: digest(canonicalExecutionBudgetGrantRequest(request)),
    workflowId: request.workflowId,
    epoch: request.epoch,
    jobId: request.jobId,
    mandateBinding: assertExecutionGrantMandateBinding(
      request.mandateBinding,
      invalidGrant,
    ),
    allowedChanges: request.requestedChanges.map((change) =>
      cloneChange(change, invalidGrant),
    ),
    maxUses: input.maxUses,
    issuedAt,
    issuer: input.issuer,
  };
  const envelope = { payload, signature: input.signature };
  validateExecutionBudgetGrantEnvelope(envelope);
  return envelope;
}

export function canonicalExecutionBudgetGrantSigningBytes(
  payload: ExecutionBudgetGrantPayload,
): string {
  validateExecutionBudgetGrantPayload(payload);
  return `${EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE}\n${canonicalJson(payload)}\n`;
}

export function canonicalExecutionBudgetGrantEnvelope(
  envelope: ExecutionBudgetGrantEnvelope,
): string {
  validateExecutionBudgetGrantEnvelope(envelope);
  return `${canonicalJson(envelope)}\n`;
}

export function parseExecutionBudgetGrantEnvelope(
  raw: string,
): ExecutionBudgetGrantEnvelope {
  try {
    const value = parseDocument(raw);
    validateExecutionBudgetGrantEnvelope(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'EXECUTION_BUDGET_GRANT_INVALID',
      'Execution-budget grant envelope is malformed.',
    );
  }
}

export function validateExecutionBudgetGrantRequest(
  value: unknown,
): asserts value is ExecutionBudgetGrantRequest {
  const keys = [
    'schemaVersion',
    'kind',
    'requestId',
    'workflowId',
    'epoch',
    'jobId',
    'mandateBinding',
    'requestedChanges',
    'rationale',
    'expiresAfterAttempts',
    'createdAt',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-grant-request'
  ) {
    throw invalidGrantRequest('Grant request has an invalid shape.');
  }
  assertUuid(value.requestId, invalidGrantRequest);
  assertIdentity(value.workflowId, invalidGrantRequest, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidGrantRequest, 'epoch');
  assertIdentity(value.jobId, invalidGrantRequest, 'job ID');
  assertExecutionGrantMandateBinding(value.mandateBinding, invalidGrantRequest);
  validateChanges(value.requestedChanges, invalidGrantRequest);
  assertReason(value.rationale, invalidGrantRequest, 'rationale');
  assertBoundedInteger(
    value.expiresAfterAttempts,
    1,
    MAX_GRANT_USES,
    invalidGrantRequest,
    'attempt bound',
  );
  assertTimestamp(value.createdAt, invalidGrantRequest, 'createdAt');
}

function validateExecutionBudgetGrantPayload(
  value: unknown,
): asserts value is ExecutionBudgetGrantPayload {
  const keys = [
    'schemaVersion',
    'kind',
    'grantId',
    'requestDigest',
    'workflowId',
    'epoch',
    'jobId',
    'mandateBinding',
    'allowedChanges',
    'maxUses',
    'issuedAt',
    'issuer',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-grant.v1'
  ) {
    throw invalidGrant('Grant payload has an invalid shape.');
  }
  assertUuid(value.grantId, invalidGrant);
  assertDigest(value.requestDigest, invalidGrant, 'request digest');
  assertIdentity(value.workflowId, invalidGrant, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidGrant, 'epoch');
  assertIdentity(value.jobId, invalidGrant, 'job ID');
  assertExecutionGrantMandateBinding(value.mandateBinding, invalidGrant);
  validateChanges(value.allowedChanges, invalidGrant);
  assertBoundedInteger(
    value.maxUses,
    1,
    MAX_GRANT_USES,
    invalidGrant,
    'maximum uses',
  );
  assertTimestamp(value.issuedAt, invalidGrant, 'issuedAt');
  assertIdentity(value.issuer, invalidGrant, 'issuer');
}

export function validateExecutionBudgetGrantEnvelope(
  value: unknown,
): asserts value is ExecutionBudgetGrantEnvelope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'signature']) ||
    typeof value.signature !== 'string' ||
    value.signature.length < 1 ||
    value.signature.length > 16_384 ||
    value.signature.includes('\0')
  ) {
    throw invalidGrant('Grant envelope has an invalid shape or signature.');
  }
  validateExecutionBudgetGrantPayload(value.payload);
}

export function validateExecutionBudgetConsumeReceipt(
  value: unknown,
  payload?: ExecutionBudgetGrantPayload,
): asserts value is ExecutionBudgetConsumeReceipt {
  const keys = [
    'schemaVersion',
    'kind',
    'receiptId',
    'grantId',
    'requestDigest',
    'workflowId',
    'epoch',
    'jobId',
    'mandateBinding',
    'attemptId',
    'useNumber',
    'remainingUses',
    'consumedAt',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-budget-consume-receipt'
  ) {
    throw unsafeGrantStore();
  }
  assertDigest(value.receiptId, unsafeGrantStore, 'receipt ID');
  assertUuid(value.grantId, unsafeGrantStore);
  assertDigest(value.requestDigest, unsafeGrantStore, 'request digest');
  assertIdentity(value.workflowId, unsafeGrantStore, 'workflow ID');
  assertPositiveInteger(value.epoch, unsafeGrantStore, 'epoch');
  assertIdentity(value.jobId, unsafeGrantStore, 'job ID');
  assertExecutionGrantMandateBinding(value.mandateBinding, unsafeGrantStore);
  assertIdentity(value.attemptId, unsafeGrantStore, 'attempt ID');
  assertBoundedInteger(
    value.useNumber,
    1,
    MAX_GRANT_USES,
    unsafeGrantStore,
    'use',
  );
  assertBoundedInteger(
    value.remainingUses,
    0,
    MAX_GRANT_USES - 1,
    unsafeGrantStore,
    'remaining uses',
  );
  assertTimestamp(value.consumedAt, unsafeGrantStore, 'consumedAt');
  const { receiptId: _receiptId, ...core } = value;
  if (value.receiptId !== digest(canonicalJson(core))) throw unsafeGrantStore();
  if (
    payload &&
    (value.grantId !== payload.grantId ||
      value.requestDigest !== payload.requestDigest ||
      value.workflowId !== payload.workflowId ||
      value.epoch !== payload.epoch ||
      value.jobId !== payload.jobId ||
      canonicalJson(value.mandateBinding) !==
        canonicalJson(payload.mandateBinding) ||
      value.useNumber + value.remainingUses !== payload.maxUses)
  ) {
    throw unsafeGrantStore();
  }
}

export function canonicalGrantRecord(
  record: ExecutionBudgetGrantRecord,
): string {
  validateGrantRecord(record);
  return `${canonicalJson(record)}\n`;
}

export function validateGrantRecord(
  value: unknown,
): asserts value is ExecutionBudgetGrantRecord {
  if (
    isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion !== 3
  ) {
    throw unsupportedSchemaVersion(value.schemaVersion);
  }
  const currentKeys = [
    'schemaVersion',
    'state',
    'envelopeDigest',
    'envelope',
    'remainingUses',
    'consumedAttemptIds',
    'receipts',
    'revokedAt',
    'revocationReason',
  ];
  if (
    !isRecord(value) ||
    value.schemaVersion !== 3 ||
    !hasExactKeys(value, currentKeys) ||
    !['active', 'consumed', 'revoked'].includes(String(value.state))
  ) {
    throw unsafeGrantStore();
  }
  validateExecutionBudgetGrantEnvelope(value.envelope);
  assertDigest(value.envelopeDigest, unsafeGrantStore, 'envelope digest');
  if (
    value.envelopeDigest !==
    digest(canonicalExecutionBudgetGrantEnvelope(value.envelope))
  ) {
    throw unsafeGrantStore();
  }
  const payload = value.envelope.payload;
  assertBoundedInteger(
    value.remainingUses,
    0,
    payload.maxUses,
    unsafeGrantStore,
    'remaining uses',
  );
  if (
    !Array.isArray(value.consumedAttemptIds) ||
    !Array.isArray(value.receipts) ||
    value.consumedAttemptIds.length !== value.receipts.length ||
    value.receipts.length + (value.remainingUses as number) !==
      payload.maxUses ||
    (value.state === 'active' && value.remainingUses === 0) ||
    (value.state === 'consumed' && value.remainingUses !== 0) ||
    (value.state === 'revoked' && value.remainingUses === 0)
  ) {
    throw unsafeGrantStore();
  }
  if (value.state === 'revoked') {
    assertTimestamp(value.revokedAt, unsafeGrantStore, 'revokedAt');
    assertReason(value.revocationReason, unsafeGrantStore, 'revocation reason');
    const latestAuthorityAt =
      value.receipts.at(-1)?.consumedAt ?? payload.issuedAt;
    if (
      new Date(value.revokedAt as string).getTime() <
      new Date(latestAuthorityAt).getTime()
    ) {
      throw unsafeGrantStore();
    }
  } else if (value.revokedAt !== null || value.revocationReason !== null) {
    throw unsafeGrantStore();
  }
  const attemptIds = new Set<string>();
  for (let index = 0; index < value.receipts.length; index += 1) {
    const receipt = value.receipts[index];
    validateExecutionBudgetConsumeReceipt(receipt, payload);
    if (
      receipt.useNumber !== index + 1 ||
      receipt.remainingUses !== payload.maxUses - index - 1 ||
      value.consumedAttemptIds[index] !== receipt.attemptId ||
      attemptIds.has(receipt.attemptId)
    ) {
      throw unsafeGrantStore();
    }
    attemptIds.add(receipt.attemptId);
  }
}

function cloneChange(
  change: ExecutionBudgetChange,
  invalid: (message: string) => WorkflowError,
): ExecutionBudgetChange {
  return {
    path: change.path,
    from: cloneJson(change.from, invalid),
    to: cloneJson(change.to, invalid),
  };
}

function sortChanges(
  changes: ExecutionBudgetChange[],
  invalid: (message: string) => WorkflowError,
): ExecutionBudgetChange[] {
  if (!Array.isArray(changes)) return changes;
  return changes
    .map((change) => cloneChange(change, invalid))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function validateChanges(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): asserts value is ExecutionBudgetChange[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw invalid('Execution-budget changes must be a non-empty bounded list.');
  }
  let previous = '';
  for (const change of value) {
    if (
      !isRecord(change) ||
      !hasExactKeys(change, ['path', 'from', 'to']) ||
      typeof change.path !== 'string' ||
      !JSON_POINTER.test(change.path) ||
      change.path <= previous
    ) {
      throw invalid(
        'Execution-budget changes must use sorted unique JSON-pointer paths.',
      );
    }
    assertJsonValue(change.from, invalid);
    assertJsonValue(change.to, invalid);
    if (canonicalJson(change.from) === canonicalJson(change.to)) {
      throw invalid('Execution-budget change must alter its value.');
    }
    previous = change.path;
  }
}

export function assertExecutionGrantMandateBinding(
  value: unknown,
  invalid: (message: string) => WorkflowError,
): TaskMandateBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
    typeof value.mandateId !== 'string' ||
    !UUID_V4.test(value.mandateId) ||
    typeof value.mandateDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot ||
    value.externalAuditRoot.length > 4_096
  ) {
    throw invalid('Task Mandate binding is malformed.');
  }
  return structuredClone(value) as TaskMandateBinding;
}

export function invalidGrantRequest(message: string): WorkflowError {
  return workflowError(
    'EXECUTION_GRANT_REQUEST_INVALID',
    message,
    ExitCode.usage,
  );
}

export function invalidGrant(message: string): WorkflowError {
  return workflowError(
    'EXECUTION_BUDGET_GRANT_INVALID',
    message,
    ExitCode.usage,
  );
}

function unsupportedSchemaVersion(schemaVersion: number): WorkflowError {
  return workflowError(
    'UNSUPPORTED_SCHEMA_VERSION',
    `Execution-budget grant record schema version ${schemaVersion} is unsupported; only schema version 3 is current.`,
    ExitCode.guard,
    { details: { schemaVersion, supportedSchemaVersion: 3 } },
  );
}

export function unsafeGrantStore(): WorkflowError {
  return workflowError(
    'EXECUTION_BUDGET_GRANT_STORE_UNSAFE',
    'Execution-budget grant store is missing, malformed, or unsafe.',
    ExitCode.staleState,
  );
}
