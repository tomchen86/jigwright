/**
 * Builds complete repair contexts and accounts for bounded schema and semantic retries.
 *
 * Invariants:
 * - Repair contexts retain exact execution bindings and require complete replacement validation.
 * - Attempt totals agree with sorted fingerprint counts and the configured repair limits.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  type WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertBoundedInteger,
  assertDigest,
  assertIdentity,
  assertJsonValue,
  assertPositiveInteger,
  cloneJson,
  hasExactKeys,
  IDENTITY,
  invalidRepairContext,
  isRecord,
  isSorted,
  JSON_POINTER,
  type JsonValue,
  MAX_DOCUMENT_BYTES,
  normalizeInvalid,
  parseDocument,
} from './execution-governance-values.ts';

export type RepairKind = 'schema' | 'semantic';

export type StructuredValidationError = {
  path: string;
  code: string;
  message: string;
};

export type RepairContext = {
  schemaVersion: 1;
  kind: 'repair-context.v1';
  repairKind: RepairKind;
  workflowId: string;
  epoch: number;
  jobId: string;
  attemptId: string;
  contextDigest: string;
  previousOutput: JsonValue;
  validationErrors: StructuredValidationError[];
  targetSchema: JsonValue;
  instruction: string;
  requiresFullValidation: true;
};

export type RepairBudget = {
  schemaVersion: 1;
  kind: 'repair-budget.v1';
  maxSchemaAttempts: number;
  maxSemanticAttempts: number;
  maxSameFailureFingerprint: number;
  schemaAttempts: number;
  semanticAttempts: number;
  fingerprints: { fingerprint: string; count: number }[];
};

const REPAIR_INSTRUCTION =
  'Return one complete replacement object that satisfies every validation error and the target schema.';

export function buildRepairContext(input: {
  repairKind: RepairKind;
  workflowId: string;
  epoch: number;
  jobId: string;
  attemptId: string;
  contextDigest: string;
  previousOutput: JsonValue;
  validationErrors: StructuredValidationError[];
  targetSchema: JsonValue;
}): RepairContext {
  const context: RepairContext = {
    schemaVersion: 1,
    kind: 'repair-context.v1',
    repairKind: input.repairKind,
    workflowId: input.workflowId,
    epoch: input.epoch,
    jobId: input.jobId,
    attemptId: input.attemptId,
    contextDigest: input.contextDigest,
    previousOutput: cloneJson(input.previousOutput),
    validationErrors: [...input.validationErrors]
      .map((error) => ({ ...error }))
      .sort(compareValidationErrors),
    targetSchema: cloneJson(input.targetSchema),
    instruction: REPAIR_INSTRUCTION,
    requiresFullValidation: true,
  };
  validateRepairContext(context);
  return context;
}

export function canonicalRepairContext(context: RepairContext): string {
  validateRepairContext(context);
  return `${canonicalJson(context)}\n`;
}

export function parseRepairContext(raw: string): RepairContext {
  try {
    const value = parseDocument(raw);
    validateRepairContext(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'REPAIR_CONTEXT_INVALID',
      'Repair context is malformed.',
    );
  }
}

export function createRepairBudget(
  input: {
    maxSchemaAttempts?: number;
    maxSemanticAttempts?: number;
    maxSameFailureFingerprint?: number;
  } = {},
): RepairBudget {
  const budget: RepairBudget = {
    schemaVersion: 1,
    kind: 'repair-budget.v1',
    maxSchemaAttempts: input.maxSchemaAttempts ?? 2,
    maxSemanticAttempts: input.maxSemanticAttempts ?? 1,
    maxSameFailureFingerprint: input.maxSameFailureFingerprint ?? 2,
    schemaAttempts: 0,
    semanticAttempts: 0,
    fingerprints: [],
  };
  validateRepairBudget(budget);
  return budget;
}

export function consumeRepairBudget(
  current: RepairBudget,
  repairKind: RepairKind,
  failureFingerprint: string,
): RepairBudget {
  validateRepairBudget(current);
  if (repairKind !== 'schema' && repairKind !== 'semantic') {
    throw invalidRepairBudget('Repair kind must be schema or semantic.');
  }
  assertFingerprint(failureFingerprint);
  const budget: RepairBudget = {
    ...current,
    fingerprints: current.fingerprints.map((entry) => ({ ...entry })),
  };
  const entry = budget.fingerprints.find(
    ({ fingerprint }) => fingerprint === failureFingerprint,
  );
  const fingerprintCount = entry?.count ?? 0;
  const exhaustedByKind =
    repairKind === 'schema'
      ? budget.schemaAttempts >= budget.maxSchemaAttempts
      : budget.semanticAttempts >= budget.maxSemanticAttempts;
  if (exhaustedByKind || fingerprintCount >= budget.maxSameFailureFingerprint) {
    throw workflowError(
      'REPAIR_BUDGET_EXHAUSTED',
      `${repairKind} repair budget is exhausted.`,
      ExitCode.guard,
    );
  }
  if (repairKind === 'schema') budget.schemaAttempts += 1;
  else budget.semanticAttempts += 1;
  if (entry) entry.count += 1;
  else budget.fingerprints.push({ fingerprint: failureFingerprint, count: 1 });
  budget.fingerprints.sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint),
  );
  validateRepairBudget(budget);
  return budget;
}

export function canonicalRepairBudget(budget: RepairBudget): string {
  validateRepairBudget(budget);
  return `${canonicalJson(budget)}\n`;
}

export function parseRepairBudget(raw: string): RepairBudget {
  try {
    const value = parseDocument(raw);
    validateRepairBudget(value);
    return value;
  } catch (error) {
    throw normalizeInvalid(
      error,
      'REPAIR_BUDGET_INVALID',
      'Repair budget is malformed.',
    );
  }
}

function validateRepairContext(value: unknown): asserts value is RepairContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'repairKind',
      'workflowId',
      'epoch',
      'jobId',
      'attemptId',
      'contextDigest',
      'previousOutput',
      'validationErrors',
      'targetSchema',
      'instruction',
      'requiresFullValidation',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'repair-context.v1' ||
    (value.repairKind !== 'schema' && value.repairKind !== 'semantic') ||
    value.instruction !== REPAIR_INSTRUCTION ||
    value.requiresFullValidation !== true
  ) {
    throw invalidRepairContext('Repair context has an invalid shape.');
  }
  assertIdentity(value.workflowId, invalidRepairContext, 'workflow ID');
  assertPositiveInteger(value.epoch, invalidRepairContext, 'epoch');
  assertIdentity(value.jobId, invalidRepairContext, 'job ID');
  assertIdentity(value.attemptId, invalidRepairContext, 'attempt ID');
  assertDigest(value.contextDigest, invalidRepairContext, 'context digest');
  assertJsonValue(value.previousOutput, invalidRepairContext);
  assertJsonValue(value.targetSchema, invalidRepairContext);
  if (
    !Array.isArray(value.validationErrors) ||
    value.validationErrors.length < 1 ||
    value.validationErrors.length > 100
  ) {
    throw invalidRepairContext(
      'Repair context requires bounded validation errors.',
    );
  }
  const errors = value.validationErrors as unknown[];
  for (const error of errors) {
    if (
      !isRecord(error) ||
      !hasExactKeys(error, ['path', 'code', 'message']) ||
      typeof error.path !== 'string' ||
      (!JSON_POINTER.test(error.path) && error.path !== '') ||
      typeof error.code !== 'string' ||
      !IDENTITY.test(error.code) ||
      typeof error.message !== 'string' ||
      error.message.trim() !== error.message ||
      error.message.length < 1 ||
      error.message.length > 500
    ) {
      throw invalidRepairContext('Validation error is malformed.');
    }
  }
  if (
    !isSorted(errors as StructuredValidationError[], compareValidationErrors)
  ) {
    throw invalidRepairContext('Validation errors must be sorted canonically.');
  }
  if (Buffer.byteLength(canonicalJson(value)) > MAX_DOCUMENT_BYTES) {
    throw invalidRepairContext('Repair context exceeds its size bound.');
  }
}

function validateRepairBudget(value: unknown): asserts value is RepairBudget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'maxSchemaAttempts',
      'maxSemanticAttempts',
      'maxSameFailureFingerprint',
      'schemaAttempts',
      'semanticAttempts',
      'fingerprints',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'repair-budget.v1'
  ) {
    throw invalidRepairBudget('Repair budget has an invalid shape.');
  }
  assertBoundedInteger(
    value.maxSchemaAttempts,
    1,
    2,
    invalidRepairBudget,
    'schema repair limit',
  );
  assertBoundedInteger(
    value.maxSemanticAttempts,
    1,
    2,
    invalidRepairBudget,
    'semantic repair limit',
  );
  assertBoundedInteger(
    value.maxSameFailureFingerprint,
    1,
    3,
    invalidRepairBudget,
    'failure fingerprint limit',
  );
  assertBoundedInteger(
    value.schemaAttempts,
    0,
    value.maxSchemaAttempts as number,
    invalidRepairBudget,
    'schema repair count',
  );
  assertBoundedInteger(
    value.semanticAttempts,
    0,
    value.maxSemanticAttempts as number,
    invalidRepairBudget,
    'semantic repair count',
  );
  if (!Array.isArray(value.fingerprints) || value.fingerprints.length > 16) {
    throw invalidRepairBudget('Repair fingerprints are invalid.');
  }
  const fingerprints = value.fingerprints as unknown[];
  let previous = '';
  let total = 0;
  for (const item of fingerprints) {
    if (
      !isRecord(item) ||
      !hasExactKeys(item, ['fingerprint', 'count']) ||
      typeof item.fingerprint !== 'string'
    ) {
      throw invalidRepairBudget('Repair fingerprint entry is malformed.');
    }
    assertFingerprint(item.fingerprint);
    assertBoundedInteger(
      item.count,
      1,
      value.maxSameFailureFingerprint as number,
      invalidRepairBudget,
      'fingerprint count',
    );
    if (item.fingerprint <= previous) {
      throw invalidRepairBudget(
        'Repair fingerprints must be sorted and unique.',
      );
    }
    previous = item.fingerprint;
    total += item.count as number;
  }
  if (
    total !==
    (value.schemaAttempts as number) + (value.semanticAttempts as number)
  ) {
    throw invalidRepairBudget('Repair fingerprint counts do not match usage.');
  }
}

function compareValidationErrors(
  left: StructuredValidationError,
  right: StructuredValidationError,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}

function assertFingerprint(value: string): void {
  if (!IDENTITY.test(value)) {
    throw invalidRepairBudget('Failure fingerprint is invalid.');
  }
}

function invalidRepairBudget(message: string): WorkflowError {
  return workflowError('REPAIR_BUDGET_INVALID', message, ExitCode.usage);
}
