/**
 * Persist exact provider repair evidence and consume bounded repair lineage authority.
 *
 * Invariants:
 * - Repair budget replay, evidence publication, and replacement lineage ordering stay exact.
 * - Canonical evidence, error bounds, and request bindings remain unchanged.
 */

import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type RepairContext as ExecutionRepairContext,
  projectProviderInvocationExecution,
  createReplacementAttempt,
  providerExecutionPolicySnapshot,
  providerExecutionEnvironmentDigest,
} from '../../modules/provider-orchestration/execution-core.ts';
import {
  type RepairKind,
  type StructuredValidationError,
  buildRepairContext,
  type RepairBudget,
  consumeRepairBudget,
  createRepairBudget,
  canonicalRepairBudget,
  parseRepairContext,
  canonicalRepairContext,
  parseRepairBudget,
} from '../../modules/authority/execution-governance-repair.ts';
import { type JsonValue } from '../../modules/authority/execution-governance-values.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import {
  privatePathExists,
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
} from '../journal-primitives/investigation-private-files.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderRepairAuthorityBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import type {
  ProviderInvocationRecord,
  ProviderInvocationFailure,
} from '../../modules/provider-orchestration/provider-invocation-record.ts';
import {
  providerRepairUnsafe,
  isRecord,
  hasExactKeys,
  isTimestamp,
  sha256Hex,
  providerRepairInvalid,
  digestCanonical,
  digestText,
  isDigest,
} from './provider-governance-values.ts';

const MAX_REPAIR_VALUE_BYTES = 262_144;

const MAX_REPAIR_ERRORS = 64;

const MAX_REPAIR_ERROR_MESSAGE_BYTES = 4_096;

export type ProviderRepairFailureInput = Readonly<{
  repairKind: RepairKind;
  previousOutput: JsonValue;
  validationErrors: StructuredValidationError[];
  targetSchema: JsonValue;
}>;

export type ProviderRepairEvidence = Readonly<{
  schemaVersion: 1;
  kind: 'provider-repair-evidence';
  failedInvocationId: string;
  failedAttemptId: string;
  failureCode: string;
  failureFingerprint: string;
  workflowId: string;
  jobId: string;
  epoch: number;
  contextDigest: string;
  repairContext: ReturnType<typeof buildRepairContext>;
  recordedAt: string;
  evidenceDigest: string;
}>;

export type ProviderRepairLineage = Readonly<{
  schemaVersion: 1;
  kind: 'provider-repair-lineage';
  replacementInvocationId: string;
  replacementAttemptId: string;
  replacementRequestDigest: string;
  failedInvocationId: string;
  failedAttemptId: string;
  repairEvidenceDigest: string;
  failureFingerprint: string;
  workflowId: string;
  jobId: string;
  epoch: number;
  contextDigest: string;
  retryMode: 'repair';
  repairKind: RepairKind;
  repairContext: ExecutionRepairContext;
  repairBudget: RepairBudget;
  createdAt: string;
  lineageDigest: string;
}>;

type ProviderExecutionEntry = Readonly<{
  record: ProviderInvocationRecord;
  request: ProviderInvocationRequest;
}>;

/**
 * Replay and consume the bounded per-kind RepairBudget without publishing a
 * replacement artifact. Retry callers run this before their durable
 * reservation/ref transition so a stricter semantic/schema budget cannot fail
 * after partial invocation files have appeared.
 */
export function preflightProviderRepairRetry(
  paths: InvestigationRuntimePaths,
  input: {
    history: readonly ProviderExecutionEntry[];
    failedRecord: ProviderInvocationRecord;
    failedRequest: ProviderInvocationRequest;
  },
): RepairBudget | null {
  const failed = projectProviderInvocationExecution({
    record: input.failedRecord,
    request: input.failedRequest,
  });
  if (failed.attempt.failure?.retryClass !== 'repairable') return null;
  const evidencePath = repairEvidencePath(
    paths,
    input.failedRecord.invocationId,
  );
  if (!privatePathExists(paths, evidencePath, providerRepairUnsafe)) {
    throw workflowError(
      'PROVIDER_REPAIR_EVIDENCE_REQUIRED',
      'A repairable failure requires its durable structured repair artifact.',
      ExitCode.guard,
    );
  }
  const evidence = readProviderRepairEvidence(
    paths,
    input.failedRecord,
    input.failedRequest,
  );
  const jobHistory = input.history.filter(
    (entry) =>
      projectProviderInvocationExecution(entry).job.jobId === failed.job.jobId,
  );
  const budget = replayRepairBudget(paths, jobHistory);
  return consumeRepairBudget(
    budget,
    evidence.repairContext.repairKind,
    evidence.failureFingerprint,
  );
}

export function extractProviderRepairFailure(
  error: unknown,
  targetSchema: unknown,
): ProviderRepairFailureInput | null {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROVIDER_NATIVE_OUTPUT_INVALID'
  ) {
    return null;
  }
  const repair = error.details?.repair;
  if (
    !isRecord(repair) ||
    !hasExactKeys(repair, ['previousOutput', 'repairKind', 'validationErrors'])
  ) {
    return null;
  }
  return normalizeRepairFailureInput({
    repairKind: repair.repairKind,
    previousOutput: repair.previousOutput,
    validationErrors: repair.validationErrors,
    targetSchema,
  });
}

export function persistProviderRepairEvidence(
  paths: InvestigationRuntimePaths,
  input: {
    record: ProviderInvocationRecord;
    request: ProviderInvocationRequest;
    failure: ProviderInvocationFailure;
    repair: ProviderRepairFailureInput;
    recordedAt: string;
  },
): ProviderRepairEvidence {
  const repair = normalizeRepairFailureInput(input.repair);
  if (
    input.failure.kind !== 'retryable' ||
    !isTimestamp(input.recordedAt) ||
    sha256Hex(canonicalJson(repair.targetSchema)) !==
      input.request.outputSchema.digest
  ) {
    throw providerRepairInvalid('Repair evidence is not bound to the request.');
  }
  const failedRecord: ProviderInvocationRecord = {
    ...input.record,
    revision: input.record.revision + 1,
    state: 'failed',
    lease: null,
    result: null,
    failure: input.failure,
    updatedAt: input.recordedAt,
  };
  const projection = projectProviderInvocationExecution({
    record: failedRecord,
    request: input.request,
  });
  if (
    projection.attempt.failure === null ||
    projection.attempt.failure.retryClass !== 'repairable'
  ) {
    throw providerRepairInvalid(
      'Only a validator-classified failure may publish repair evidence.',
    );
  }
  const context = buildRepairContext({
    repairKind: repair.repairKind,
    workflowId: projection.workflow.workflowId,
    epoch: projection.job.epoch,
    jobId: projection.job.jobId,
    attemptId: projection.attempt.attemptId,
    contextDigest: projection.job.contextDigest,
    previousOutput: repair.previousOutput,
    validationErrors: repair.validationErrors,
    targetSchema: repair.targetSchema,
  });
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-repair-evidence' as const,
    failedInvocationId: input.record.invocationId,
    failedAttemptId: projection.attempt.attemptId,
    failureCode: projection.attempt.failure.code,
    failureFingerprint: projection.attempt.failure.fingerprint,
    workflowId: projection.workflow.workflowId,
    jobId: projection.job.jobId,
    epoch: projection.job.epoch,
    contextDigest: projection.job.contextDigest,
    repairContext: context,
    recordedAt: input.recordedAt,
  };
  const evidence: ProviderRepairEvidence = Object.freeze({
    ...payload,
    evidenceDigest: digestCanonical(payload),
  });
  const filePath = repairEvidencePath(paths, input.record.invocationId);
  if (privatePathExists(paths, filePath, providerRepairUnsafe)) {
    const existing = readProviderRepairEvidence(
      paths,
      failedRecord,
      input.request,
    );
    if (canonicalJson(existing) !== canonicalJson(evidence)) {
      throw workflowError(
        'PROVIDER_REPAIR_EVIDENCE_CONFLICT',
        'A different repair artifact already exists for this Attempt.',
        ExitCode.conflict,
      );
    }
    return existing;
  }
  createPrivateCanonicalJson(
    paths,
    filePath,
    evidence,
    providerRepairUnsafe,
    'PROVIDER_REPAIR_EVIDENCE_CONFLICT',
  );
  return readProviderRepairEvidence(paths, failedRecord, input.request);
}

export function readProviderRepairEvidence(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): ProviderRepairEvidence {
  const value = readPrivateCanonicalJson(
    paths,
    repairEvidencePath(paths, record.invocationId),
    providerRepairUnsafe,
  );
  const evidence = assertProviderRepairEvidence(value);
  const projection = projectProviderInvocationExecution({ record, request });
  if (
    record.state !== 'failed' ||
    projection.attempt.failure === null ||
    evidence.failedInvocationId !== record.invocationId ||
    evidence.failedAttemptId !== projection.attempt.attemptId ||
    evidence.failureCode !== projection.attempt.failure.code ||
    evidence.failureFingerprint !== projection.attempt.failure.fingerprint ||
    evidence.workflowId !== projection.workflow.workflowId ||
    evidence.jobId !== projection.job.jobId ||
    evidence.epoch !== projection.job.epoch ||
    evidence.contextDigest !== projection.job.contextDigest
  ) {
    throw providerRepairUnsafe();
  }
  return evidence;
}

export function loadProviderExecutionRepairContext(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): ExecutionRepairContext {
  return executionRepairContext(
    readProviderRepairEvidence(paths, record, request),
  );
}

export function createProviderRepairLineage(
  paths: InvestigationRuntimePaths,
  input: {
    history: readonly ProviderExecutionEntry[];
    replacementRecord: ProviderInvocationRecord;
    replacementRequest: ProviderInvocationRequest;
  },
): ProviderRepairLineage | null {
  const replacementProjection = projectProviderInvocationExecution({
    record: input.replacementRecord,
    request: input.replacementRequest,
  });
  const jobHistory = input.history.filter(
    (entry) =>
      projectProviderInvocationExecution(entry).job.jobId ===
      replacementProjection.job.jobId,
  );
  const previousEntry = jobHistory
    .filter(
      ({ record }) =>
        record.investigationId === input.replacementRecord.investigationId &&
        record.purpose === input.replacementRecord.purpose &&
        record.attempt === input.replacementRecord.attempt - 1,
    )
    .at(0);
  if (previousEntry === undefined) return null;
  const previous = projectProviderInvocationExecution(previousEntry);
  if (previous.attempt.failure?.retryClass !== 'repairable') return null;
  const evidencePath = repairEvidencePath(
    paths,
    previousEntry.record.invocationId,
  );
  if (!privatePathExists(paths, evidencePath, providerRepairUnsafe)) {
    throw workflowError(
      'PROVIDER_REPAIR_EVIDENCE_REQUIRED',
      'A repairable failure requires its durable structured repair artifact.',
      ExitCode.guard,
    );
  }
  const evidence = readProviderRepairEvidence(
    paths,
    previousEntry.record,
    previousEntry.request,
  );
  const budget = replayRepairBudget(paths, jobHistory);
  const repairBudget = consumeRepairBudget(
    budget,
    evidence.repairContext.repairKind,
    evidence.failureFingerprint,
  );
  const repairContext = executionRepairContext(evidence);
  if (
    replacementProjection.job.jobId !== previous.job.jobId ||
    replacementProjection.job.contextDigest !== previous.job.contextDigest
  ) {
    throw providerRepairInvalid(
      'Repair replacement changed the semantic Job or context identity.',
    );
  }
  const replacement = createReplacementAttempt({
    workflow: previous.workflow,
    job: {
      ...previous.job,
      repairAttemptCount:
        repairBudget.schemaAttempts + repairBudget.semanticAttempts - 1,
    },
    previousAttempt: previous.attempt,
    attemptId: `attempt-provider-${input.replacementRecord.invocationId}`,
    retryMode: 'repair',
    currentExecutionPolicy: providerExecutionPolicySnapshot(
      input.replacementRequest,
    ),
    repairContext,
    environmentDigest: providerExecutionEnvironmentDigest(
      input.replacementRequest,
    ),
    createdAt: input.replacementRecord.createdAt,
  });
  if (
    replacement.attempt.attemptNumber !== input.replacementRecord.attempt ||
    replacement.job.jobId !== previous.job.jobId
  ) {
    throw providerRepairInvalid(
      'Repair replacement does not preserve the durable Job lineage.',
    );
  }
  const payload = {
    schemaVersion: 1 as const,
    kind: 'provider-repair-lineage' as const,
    replacementInvocationId: input.replacementRecord.invocationId,
    replacementAttemptId: replacement.attempt.attemptId,
    replacementRequestDigest: input.replacementRequest.requestDigest,
    failedInvocationId: previousEntry.record.invocationId,
    failedAttemptId: previous.attempt.attemptId,
    repairEvidenceDigest: evidence.evidenceDigest,
    failureFingerprint: evidence.failureFingerprint,
    workflowId: previous.workflow.workflowId,
    jobId: previous.job.jobId,
    epoch: previous.job.epoch,
    contextDigest: previous.job.contextDigest,
    retryMode: 'repair' as const,
    repairKind: evidence.repairContext.repairKind,
    repairContext,
    repairBudget,
    createdAt: input.replacementRecord.createdAt,
  };
  const lineage: ProviderRepairLineage = Object.freeze({
    ...payload,
    lineageDigest: digestCanonical(payload),
  });
  const filePath = repairLineagePath(
    paths,
    input.replacementRecord.invocationId,
  );
  if (privatePathExists(paths, filePath, providerRepairUnsafe)) {
    const existing = readProviderRepairLineage(
      paths,
      input.replacementRecord,
      input.replacementRequest,
    );
    if (canonicalJson(existing) !== canonicalJson(lineage)) {
      throw workflowError(
        'PROVIDER_REPAIR_LINEAGE_CONFLICT',
        'A different repair lineage already exists for this replacement.',
        ExitCode.conflict,
      );
    }
    return existing;
  }
  createPrivateCanonicalJson(
    paths,
    filePath,
    lineage,
    providerRepairUnsafe,
    'PROVIDER_REPAIR_LINEAGE_CONFLICT',
  );
  return readProviderRepairLineage(
    paths,
    input.replacementRecord,
    input.replacementRequest,
  );
}

export function readProviderRepairLineage(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): ProviderRepairLineage | null {
  const filePath = repairLineagePath(paths, record.invocationId);
  if (!privatePathExists(paths, filePath, providerRepairUnsafe)) return null;
  const lineage = assertProviderRepairLineage(
    readPrivateCanonicalJson(paths, filePath, providerRepairUnsafe),
  );
  const projection = projectProviderInvocationExecution({ record, request });
  if (
    lineage.replacementInvocationId !== record.invocationId ||
    lineage.replacementAttemptId !== projection.attempt.attemptId ||
    lineage.replacementRequestDigest !== request.requestDigest ||
    lineage.workflowId !== projection.workflow.workflowId ||
    lineage.jobId !== projection.job.jobId ||
    lineage.epoch !== projection.job.epoch ||
    lineage.contextDigest !== projection.job.contextDigest
  ) {
    throw providerRepairUnsafe();
  }
  return lineage;
}

export function readProviderRepairPromptContext(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): ExecutionRepairContext | null {
  return (
    readProviderRepairLineage(paths, record, request)?.repairContext ?? null
  );
}

export function readProviderRepairPrompt(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
): ReturnType<typeof buildRepairContext> | null {
  const lineagePath = repairLineagePath(paths, request.invocationId);
  if (!privatePathExists(paths, lineagePath, providerRepairUnsafe)) return null;
  const lineage = assertProviderRepairLineage(
    readPrivateCanonicalJson(paths, lineagePath, providerRepairUnsafe),
  );
  if (
    lineage.replacementInvocationId !== request.invocationId ||
    lineage.replacementRequestDigest !== request.requestDigest
  ) {
    throw providerRepairUnsafe();
  }
  const evidence = assertProviderRepairEvidence(
    readPrivateCanonicalJson(
      paths,
      repairEvidencePath(paths, lineage.failedInvocationId),
      providerRepairUnsafe,
    ),
  );
  if (
    evidence.evidenceDigest !== lineage.repairEvidenceDigest ||
    evidence.failedInvocationId !== lineage.failedInvocationId ||
    evidence.failedAttemptId !== lineage.failedAttemptId ||
    evidence.failureFingerprint !== lineage.failureFingerprint ||
    evidence.workflowId !== lineage.workflowId ||
    evidence.jobId !== lineage.jobId ||
    evidence.epoch !== lineage.epoch ||
    evidence.contextDigest !== lineage.contextDigest
  ) {
    throw providerRepairUnsafe();
  }
  return evidence.repairContext;
}

export function readProviderRepairAuthorityBinding(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
): ProviderRepairAuthorityBinding {
  const lineagePath = repairLineagePath(paths, record.invocationId);
  const currentEvidencePath = repairEvidencePath(paths, record.invocationId);
  const lineage = readProviderRepairLineage(paths, record, request);
  if (lineage === null) {
    if (privatePathExists(paths, currentEvidencePath, providerRepairUnsafe)) {
      throw providerRepairUnsafe();
    }
    return Object.freeze({
      invocationId: record.invocationId,
      lineagePath,
      lineageDigest: null,
      currentEvidencePath,
      evidencePath: null,
      evidenceDigest: null,
    });
  }
  if (privatePathExists(paths, currentEvidencePath, providerRepairUnsafe)) {
    throw providerRepairUnsafe();
  }
  // Reuse the complete evidence/lineage cross-check used for prompt assembly;
  // the returned prompt is intentionally discarded here.
  readProviderRepairPrompt(paths, request);
  const evidencePath = repairEvidencePath(paths, lineage.failedInvocationId);
  const evidence = assertProviderRepairEvidence(
    readPrivateCanonicalJson(paths, evidencePath, providerRepairUnsafe),
  );
  if (evidence.evidenceDigest !== lineage.repairEvidenceDigest) {
    throw providerRepairUnsafe();
  }
  return Object.freeze({
    invocationId: record.invocationId,
    lineagePath,
    lineageDigest: lineage.lineageDigest,
    currentEvidencePath,
    evidencePath,
    evidenceDigest: evidence.evidenceDigest,
  });
}

export function assertProviderRepairAuthorityCurrent(
  paths: InvestigationRuntimePaths,
  record: ProviderInvocationRecord,
  request: ProviderInvocationRequest,
  expected: ProviderRepairAuthorityBinding,
): void {
  if (
    canonicalJson(
      readProviderRepairAuthorityBinding(paths, record, request),
    ) !== canonicalJson(expected)
  ) {
    throw workflowError(
      'PROVIDER_REPAIR_AUTHORITY_STALE',
      'Provider repair authority changed after execution admission.',
      ExitCode.staleState,
    );
  }
}

function replayRepairBudget(
  paths: InvestigationRuntimePaths,
  history: readonly ProviderExecutionEntry[],
): RepairBudget {
  let budget = createRepairBudget();
  for (const entry of [...history].sort(
    (left, right) => left.record.attempt - right.record.attempt,
  )) {
    const lineage = readProviderRepairLineage(
      paths,
      entry.record,
      entry.request,
    );
    if (lineage === null) continue;
    budget = consumeRepairBudget(
      budget,
      lineage.repairKind,
      lineage.failureFingerprint,
    );
    if (
      canonicalRepairBudget(budget) !==
      canonicalRepairBudget(lineage.repairBudget)
    ) {
      throw providerRepairUnsafe();
    }
  }
  return budget;
}

function executionRepairContext(
  evidence: ProviderRepairEvidence,
): ExecutionRepairContext {
  return {
    previousOutputDigest: digestCanonical(
      evidence.repairContext.previousOutput,
    ),
    validationErrors: evidence.repairContext.validationErrors.map((error) => ({
      ...error,
      path: error.path === '' ? '/' : error.path,
    })),
    targetSchemaDigest: digestCanonical(evidence.repairContext.targetSchema),
    instruction: 'return-complete-replacement-object',
    epoch: evidence.epoch,
    contextDigest: evidence.contextDigest,
  };
}

function normalizeRepairFailureInput(
  input: unknown,
): ProviderRepairFailureInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'previousOutput',
      'repairKind',
      'targetSchema',
      'validationErrors',
    ]) ||
    (input.repairKind !== 'schema' && input.repairKind !== 'semantic') ||
    !Array.isArray(input.validationErrors)
  ) {
    throw providerRepairInvalid('Repair failure input is malformed.');
  }
  const previousOutput = boundedJsonValue(input.previousOutput, true);
  const targetSchema = boundedJsonValue(input.targetSchema, false);
  if (
    input.validationErrors.length < 1 ||
    input.validationErrors.length > MAX_REPAIR_ERRORS
  ) {
    throw providerRepairInvalid('Repair validation errors are not bounded.');
  }
  const validationErrors = input.validationErrors
    .map((value) => {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['code', 'message', 'path']) ||
        typeof value.path !== 'string' ||
        (value.path !== '' && !value.path.startsWith('/')) ||
        typeof value.code !== 'string' ||
        !/^[A-Z][A-Z0-9_]{1,127}$/.test(value.code) ||
        typeof value.message !== 'string' ||
        value.message.length < 1 ||
        Buffer.byteLength(value.message) > MAX_REPAIR_ERROR_MESSAGE_BYTES
      ) {
        throw providerRepairInvalid('Repair validation error is malformed.');
      }
      return {
        path: value.path,
        code: value.code,
        message: value.message,
      };
    })
    .sort((left, right) =>
      `${left.path}\0${left.code}\0${left.message}`.localeCompare(
        `${right.path}\0${right.code}\0${right.message}`,
      ),
    );
  return Object.freeze({
    repairKind: input.repairKind,
    previousOutput,
    validationErrors,
    targetSchema,
  });
}

function boundedJsonValue(
  value: unknown,
  summarizeOversized: boolean,
): JsonValue {
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch {
    throw providerRepairInvalid('Repair value is not canonical JSON.');
  }
  if (Buffer.byteLength(encoded) <= MAX_REPAIR_VALUE_BYTES) {
    return JSON.parse(encoded) as JsonValue;
  }
  if (!summarizeOversized) {
    throw providerRepairInvalid('Repair target schema exceeds its size bound.');
  }
  return {
    kind: 'omitted-oversized-provider-output',
    digest: digestText(encoded),
    byteLength: Buffer.byteLength(encoded),
  };
}

function assertProviderRepairEvidence(value: unknown): ProviderRepairEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'contextDigest',
      'epoch',
      'evidenceDigest',
      'failedAttemptId',
      'failedInvocationId',
      'failureCode',
      'failureFingerprint',
      'jobId',
      'kind',
      'recordedAt',
      'repairContext',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-repair-evidence' ||
    !isTimestamp(value.recordedAt) ||
    !isDigest(value.evidenceDigest)
  ) {
    throw providerRepairUnsafe();
  }
  const context = parseRepairContext(
    canonicalRepairContext(value.repairContext as never),
  );
  const payload = { ...value } as Record<string, unknown>;
  delete payload.evidenceDigest;
  if (digestCanonical(payload) !== value.evidenceDigest) {
    throw providerRepairUnsafe();
  }
  return Object.freeze({
    ...(value as Omit<ProviderRepairEvidence, 'repairContext'>),
    repairContext: context,
  });
}

function assertProviderRepairLineage(value: unknown): ProviderRepairLineage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'contextDigest',
      'createdAt',
      'epoch',
      'failedAttemptId',
      'failedInvocationId',
      'failureFingerprint',
      'jobId',
      'kind',
      'lineageDigest',
      'repairBudget',
      'repairContext',
      'repairEvidenceDigest',
      'repairKind',
      'replacementAttemptId',
      'replacementInvocationId',
      'replacementRequestDigest',
      'retryMode',
      'schemaVersion',
      'workflowId',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-repair-lineage' ||
    value.retryMode !== 'repair' ||
    (value.repairKind !== 'schema' && value.repairKind !== 'semantic') ||
    !isTimestamp(value.createdAt) ||
    !isDigest(value.lineageDigest) ||
    !isDigest(value.repairEvidenceDigest) ||
    !isDigest(value.failureFingerprint)
  ) {
    throw providerRepairUnsafe();
  }
  const budget = parseRepairBudget(
    canonicalRepairBudget(value.repairBudget as never),
  );
  const payload = { ...value } as Record<string, unknown>;
  delete payload.lineageDigest;
  if (digestCanonical(payload) !== value.lineageDigest) {
    throw providerRepairUnsafe();
  }
  return Object.freeze({
    ...(value as Omit<ProviderRepairLineage, 'repairBudget'>),
    repairBudget: budget,
  });
}

function repairEvidencePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(paths.invocations, invocationId, 'repair-evidence.json');
}

function repairLineagePath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(paths.invocations, invocationId, 'repair-lineage.json');
}
