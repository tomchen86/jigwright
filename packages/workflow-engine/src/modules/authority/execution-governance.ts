/**
 * Publishes, consumes, and revokes execution-budget grants with their durable audit trail.
 *
 * Invariants:
 * - Grant state changes retain exact request, mandate, receipt, and audit-event bindings.
 * - Pending publication and repeated consumption or revocation preserve their existing replay order.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type Sha256Digest,
  deriveAuthorityAuditRepositoryId,
} from '../../runtime/storage-journal/authority-audit-ledger.ts';
import {
  type AuthorityAuditActor,
  type AuthorityAuditServiceHooks,
  type AuthorityAuditRecordedEvent,
  recordAuthorityAuditEvent,
} from '../../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from './authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from './task-mandate.ts';
import {
  isWorkflowError,
  assertUuid,
  digest,
  assertIdentity,
  assertPositiveInteger,
  assertDigest,
  exactDate,
  assertReason,
  isRecord,
  hasExactKeys,
  IDENTITY,
} from './execution-governance-values.ts';
import {
  type ExecutionBudgetGrantEnvelope,
  type ExecutionBudgetGrantRequest,
  validateExecutionBudgetGrantEnvelope,
  canonicalExecutionBudgetGrantSigningBytes,
  invalidGrant,
  type ExecutionBudgetGrantRecord,
  canonicalExecutionBudgetGrantEnvelope,
  canonicalGrantRecord,
  unsafeGrantStore,
  type ExecutionBudgetChange,
  type ExecutionBudgetConsumeReceipt,
  validateChanges,
  assertExecutionGrantMandateBinding,
  validateExecutionBudgetConsumeReceipt,
  type ExecutionBudgetGrantInspection,
  validateExecutionBudgetGrantRequest,
  invalidGrantRequest,
  canonicalExecutionBudgetGrantRequest,
  type ExecutionBudgetGrantPayload,
  type ExecutionBudgetGrantMetricsRecord,
} from './execution-governance-grant-contracts.ts';
import {
  ensureExecutionBudgetGrantStore,
  readGrantRecord,
  unlinkExactPrivateFile,
  readGrantRecordRequired,
} from './execution-governance-grant-store.ts';
import { withExecutionGrantLock } from './execution-governance-locks.ts';
import {
  createPrivateFileAtomic,
  replacePrivateFileAtomic,
} from './execution-governance-private-files.ts';

export type {
  ContextManifest,
  ContextManifestItemReference,
} from '../lifecycle/context-manifest-contract.ts';

export { type JsonValue } from './execution-governance-values.ts';

export {
  type RepairKind,
  type StructuredValidationError,
  type RepairContext,
  type RepairBudget,
  buildRepairContext,
  canonicalRepairContext,
  parseRepairContext,
  createRepairBudget,
  consumeRepairBudget,
  canonicalRepairBudget,
  parseRepairBudget,
} from './execution-governance-repair.ts';

export {
  buildContextManifest,
  canonicalContextManifest,
  parseContextManifest,
  assemblePromptFromManifest,
  type WorkflowContextState,
  type ResultEligibilityJob,
  type AttemptResultCandidate,
  type AttemptResultEligibility,
  assessAttemptResultEligibility,
  type EpochTransitionVerification,
  type EpochCarryForwardDecision,
  type EpochCarryForwardManifest,
  type EpochTransitionReceipt,
  performEpochRollover,
  canonicalEpochTransitionReceipt,
  parseEpochTransitionReceipt,
} from './execution-governance-context.ts';

export {
  type EpochTransitionStub,
  type Retention,
  type EvidenceRetentionRecord,
  type RetentionPolicy,
  DEFAULT_RETENTION_POLICY,
  pinEvidence,
  markEpochEvidenceExpiring,
  planEvidencePruning,
  canonicalEvidenceRetentionRecord,
  parseEvidenceRetentionRecord,
  compactEpochTransitionReceipts,
  canonicalEpochTransitionStub,
} from './execution-governance-retention.ts';

export {
  EXECUTION_BUDGET_GRANT_SIGNATURE_NAMESPACE,
  type ExecutionBudgetChange,
  type ExecutionBudgetGrantRequest,
  type GrantRequest,
  type ExecutionBudgetGrantPayload,
  type ExecutionBudgetGrantEnvelope,
  type ExecutionBudgetConsumeReceipt,
  type ExecutionBudgetGrantAuthorization,
  type ExecutionBudgetGrantInspection,
  type ExecutionBudgetGrantMetricsRecord,
  createExecutionBudgetGrantRequest,
  canonicalExecutionBudgetGrantRequest,
  parseExecutionBudgetGrantRequest,
  createExecutionBudgetGrantEnvelope,
  canonicalExecutionBudgetGrantSigningBytes,
  canonicalExecutionBudgetGrantEnvelope,
  parseExecutionBudgetGrantEnvelope,
} from './execution-governance-grant-contracts.ts';

export {
  type DurableEpochContextState,
  type DurableRetentionCatalog,
  type DurablePruneReceipt,
  type DurableEpochTransitionCompactionResult,
} from './execution-governance-store-contracts.ts';

export {
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  compactDurableEpochTransitionReceipts,
  withCurrentDurableEpochContextStore,
  rolloverDurableEpochContextStore,
  assembleCurrentPromptFromStore,
  assessStoredAttemptResultEligibility,
} from './execution-governance-epoch-store.ts';

export {
  inspectDurableRetentionCatalog,
  storeDurableEvidence,
  pinDurableEvidence,
  readDurableEvidence,
  pruneDurableEvidence,
  listDurablePruneReceipts,
} from './execution-governance-evidence-store.ts';

export type ExecutionBudgetGrantAuditContext = Readonly<{
  repositoryRoot: string;
  repositoryIdentity: string;
  actor?: AuthorityAuditActor;
  serviceHooks?: AuthorityAuditServiceHooks;
  onRecord?: (entry: AuthorityAuditRecordedEvent) => void;
}>;

export function storeExecutionBudgetGrant(
  storeRoot: string,
  envelope: ExecutionBudgetGrantEnvelope,
  options: {
    request: ExecutionBudgetGrantRequest;
    mandateBinding: TaskMandateBinding;
    audit: ExecutionBudgetGrantAuditContext;
    verify: (signingBytes: string, signature: string) => void;
  },
): string {
  validateExecutionBudgetGrantEnvelope(envelope);
  const binding = requireAuditedExecutionBudgetGrant(envelope, {
    request: options?.request,
    mandateBinding: options?.mandateBinding,
    audit: options?.audit,
  });
  try {
    options.verify(
      canonicalExecutionBudgetGrantSigningBytes(envelope.payload),
      envelope.signature,
    );
  } catch (error) {
    if (isWorkflowError(error)) throw error;
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_SIGNATURE_INVALID',
      'Execution-budget grant signature verification failed.',
      ExitCode.verification,
    );
  }
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  const grantId = assertUuid(envelope.payload.grantId, invalidGrant);
  return withExecutionGrantLock(paths, grantId, () => {
    const recordPath = path.join(paths.grants, `${grantId}.json`);
    if (fs.existsSync(recordPath)) {
      throw workflowError(
        'EXECUTION_BUDGET_GRANT_EXISTS',
        `Execution-budget grant ${grantId} already exists.`,
        ExitCode.conflict,
      );
    }
    const record: ExecutionBudgetGrantRecord = {
      schemaVersion: 3,
      state: 'active',
      envelopeDigest: digest(canonicalExecutionBudgetGrantEnvelope(envelope)),
      envelope,
      remainingUses: envelope.payload.maxUses,
      consumedAttemptIds: [],
      receipts: [],
      revokedAt: null,
      revocationReason: null,
    };
    const pendingPath = path.join(paths.pending, `${grantId}.json`);
    const recordBytes = canonicalGrantRecord(record);
    const pendingStats = fs.lstatSync(pendingPath, { throwIfNoEntry: false });
    if (pendingStats === undefined) {
      createPrivateFileAtomic(pendingPath, recordBytes);
    } else if (
      canonicalGrantRecord(readGrantRecord(pendingPath)) !== recordBytes
    ) {
      throw unsafeGrantStore();
    }
    appendExecutionBudgetGrantAudit(
      envelope,
      binding,
      options.audit,
      'issue',
      envelope.payload.issuedAt,
      null,
    );
    createPrivateFileAtomic(recordPath, recordBytes);
    unlinkExactPrivateFile(pendingPath, recordBytes);
    return recordPath;
  });
}

export function consumeExecutionBudgetGrant(
  storeRoot: string,
  input: {
    grantId: string;
    workflowId: string;
    epoch: number;
    jobId: string;
    attemptId: string;
    mandateBinding: TaskMandateBinding;
    requestDigest: string;
    requestedChanges: ExecutionBudgetChange[];
    now: Date;
    audit: ExecutionBudgetGrantAuditContext;
  },
): ExecutionBudgetConsumeReceipt {
  const grantId = assertUuid(input.grantId, invalidGrant);
  assertIdentity(input.workflowId, invalidGrant, 'workflow ID');
  assertPositiveInteger(input.epoch, invalidGrant, 'epoch');
  assertIdentity(input.jobId, invalidGrant, 'job ID');
  assertIdentity(input.attemptId, invalidGrant, 'attempt ID');
  assertDigest(input.requestDigest, invalidGrant, 'grant request digest');
  validateChanges(input.requestedChanges, invalidGrant);
  const consumedAt = exactDate(input.now, 'EXECUTION_BUDGET_GRANT_INVALID');
  const inputBinding = assertExecutionGrantMandateBinding(
    input.mandateBinding,
    invalidGrant,
  );
  const audit = assertExecutionBudgetGrantAuditContext(input.audit);
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  return withExecutionGrantLock(paths, grantId, () => {
    const recordPath = path.join(paths.grants, `${grantId}.json`);
    const record = readGrantRecord(recordPath);
    const payload = record.envelope.payload;
    const storedBinding = requireStoredExecutionBudgetGrantBinding(payload);
    const refusalBinding = executionBudgetGrantRefusalBinding(
      record.envelope,
      storedBinding,
      audit,
      'execution-budget.consume',
      {
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        epoch: input.epoch,
        jobId: input.jobId,
        requestDigest: input.requestDigest,
        requestedBindingDigest: authorityRefusalDigest(inputBinding),
        requestedChangesDigest: authorityRefusalDigest(input.requestedChanges),
      },
    );
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: new Date(consumedAt),
        serviceHooks: audit.serviceHooks,
        onRecord: audit.onRecord,
      },
      () => {
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
          new Date(consumedAt).getTime() <
            new Date(payload.issuedAt).getTime() ||
          (previousConsumedAt !== undefined &&
            new Date(consumedAt).getTime() <
              new Date(previousConsumedAt).getTime())
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
        appendExecutionBudgetGrantAudit(
          record.envelope,
          binding,
          audit,
          'consume',
          consumedAt,
          receipt,
        );
        replacePrivateFileAtomic(recordPath, canonicalGrantRecord(next));
        return receipt;
      },
    );
  });
}

export function inspectExecutionBudgetGrant(
  storeRoot: string,
  grantId: string,
): ExecutionBudgetGrantInspection {
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  const record = readGrantRecordRequired(
    path.join(paths.grants, `${assertUuid(grantId, invalidGrant)}.json`),
  );
  return inspectionFromRecord(record);
}

export function revokeExecutionBudgetGrant(
  storeRoot: string,
  input: {
    grantId: string;
    mandateBinding: TaskMandateBinding;
    reason: string;
    now: Date;
    audit: ExecutionBudgetGrantAuditContext;
  },
): ExecutionBudgetGrantInspection & {
  state: 'revoked';
  revokedAt: string;
  revocationReason: string;
} {
  const grantId = assertUuid(input.grantId, invalidGrant);
  assertReason(input.reason, invalidGrant, 'revocation reason');
  const revokedAt = exactDate(input.now, 'EXECUTION_BUDGET_GRANT_INVALID');
  const inputBinding = assertExecutionGrantMandateBinding(
    input.mandateBinding,
    invalidGrant,
  );
  const audit = assertExecutionBudgetGrantAuditContext(input.audit);
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  return withExecutionGrantLock(paths, grantId, () => {
    const recordPath = path.join(paths.grants, `${grantId}.json`);
    const record = readGrantRecord(recordPath);
    const storedBinding = requireStoredExecutionBudgetGrantBinding(
      record.envelope.payload,
    );
    const refusalBinding = executionBudgetGrantRefusalBinding(
      record.envelope,
      storedBinding,
      audit,
      'execution-budget.revoke',
      {
        reasonDigest: authorityRefusalDigest(input.reason),
        requestedBindingDigest: authorityRefusalDigest(inputBinding),
      },
    );
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: new Date(revokedAt),
        serviceHooks: audit.serviceHooks,
        onRecord: audit.onRecord,
      },
      () => {
        const binding = requireCurrentExecutionBudgetGrantBinding(
          record.envelope.payload,
          inputBinding,
        );
        if (record.state === 'revoked') {
          appendExecutionBudgetGrantAudit(
            record.envelope,
            binding,
            audit,
            'revoke',
            record.revokedAt!,
            record.revocationReason!,
          );
          return revokedInspectionFromRecord(record);
        }
        if (record.state === 'consumed') {
          throw workflowError(
            'EXECUTION_BUDGET_GRANT_ALREADY_CONSUMED',
            `Execution-budget grant ${grantId} was already fully consumed.`,
            ExitCode.guard,
          );
        }
        const latestAuthorityAt =
          record.receipts.at(-1)?.consumedAt ??
          record.envelope.payload.issuedAt;
        if (
          new Date(revokedAt).getTime() < new Date(latestAuthorityAt).getTime()
        ) {
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
        appendExecutionBudgetGrantAudit(
          record.envelope,
          binding,
          audit,
          'revoke',
          revokedAt,
          input.reason,
        );
        replacePrivateFileAtomic(recordPath, canonicalGrantRecord(revoked));
        return revokedInspectionFromRecord(revoked);
      },
    );
  });
}

function inspectionFromRecord(
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

function revokedInspectionFromRecord(
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

function requireAuditedExecutionBudgetGrant(
  envelope: ExecutionBudgetGrantEnvelope,
  input: {
    request: ExecutionBudgetGrantRequest | undefined;
    mandateBinding: TaskMandateBinding | undefined;
    audit: ExecutionBudgetGrantAuditContext | undefined;
  },
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
  assertExecutionBudgetGrantAuditContext(input.audit);
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

function requireCurrentExecutionBudgetGrantBinding(
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

function requireStoredExecutionBudgetGrantBinding(
  payload: ExecutionBudgetGrantPayload,
): TaskMandateBinding {
  return assertExecutionGrantMandateBinding(
    payload.mandateBinding,
    unsafeGrantStore,
  );
}

function executionBudgetGrantRefusalBinding(
  envelope: ExecutionBudgetGrantEnvelope,
  binding: TaskMandateBinding,
  audit: ExecutionBudgetGrantAuditContext,
  operation: 'execution-budget.consume' | 'execution-budget.revoke',
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const grantDigest = digest(
    canonicalExecutionBudgetGrantEnvelope(envelope),
  ) as Sha256Digest;
  return {
    scope: {
      // The external root always comes from the parsed durable grant envelope,
      // never from the caller's requested binding.
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: audit.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    },
    family: 'execution-budget-grant',
    operation,
    subjectId: envelope.payload.grantId,
    actor: audit.actor ?? { kind: 'engine', identity: 'workflow-engine' },
    taskId: binding.mandateTaskId,
    changeId: binding.changeId,
    workflowId: envelope.payload.workflowId,
    grantDigest,
    bindingDigest: grantDigest,
    refusalIdentity: {
      grantId: envelope.payload.grantId,
      ...refusalIdentity,
    },
  };
}

function appendExecutionBudgetGrantAudit(
  envelope: ExecutionBudgetGrantEnvelope,
  binding: TaskMandateBinding,
  rawAudit: ExecutionBudgetGrantAuditContext,
  transition: 'issue' | 'consume' | 'revoke',
  occurredAt: string,
  detail: ExecutionBudgetConsumeReceipt | string | null,
): AuthorityAuditRecordedEvent {
  const audit = assertExecutionBudgetGrantAuditContext(rawAudit);
  const grantDigest = digest(
    canonicalExecutionBudgetGrantEnvelope(envelope),
  ) as Sha256Digest;
  const transitionDetail =
    transition === 'consume'
      ? (detail as ExecutionBudgetConsumeReceipt).receiptId
      : transition === 'revoke'
        ? (detail as string)
        : envelope.payload.requestDigest;
  const idempotencyKey = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'execution-budget-audit-idempotency.v1',
      transition,
      grantDigest,
      detail: transitionDetail,
    }),
  ) as Sha256Digest;
  const outcomeDigest = digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'execution-budget-audit-outcome.v1',
      transition,
      grantId: envelope.payload.grantId,
      requestDigest: envelope.payload.requestDigest,
      mandateBinding: binding,
      detail: transitionDetail,
    }),
  ) as Sha256Digest;
  const entry = recordAuthorityAuditEvent(
    {
      externalAuditRoot: binding.externalAuditRoot,
      repositoryRoot: audit.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    },
    {
      eventType:
        transition === 'issue'
          ? 'escalation-request'
          : transition === 'consume'
            ? 'grant-consume'
            : 'revoke',
      occurredAt,
      idempotencyKey,
      actor:
        audit.actor ??
        (transition === 'issue'
          ? { kind: 'human', identity: envelope.payload.issuer }
          : { kind: 'engine', identity: 'workflow-engine' }),
      taskId: binding.mandateTaskId,
      changeId: binding.changeId,
      workflowId: envelope.payload.workflowId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: outcomeDigest,
      command: {
        name: `execution-budget.${transition}`,
        argvDigest: digest(
          canonicalJson({
            grantId: envelope.payload.grantId,
            jobId: envelope.payload.jobId,
            transition,
          }),
        ) as Sha256Digest,
      },
      providerInvocation: null,
      externalEffect: null,
      result:
        transition === 'consume'
          ? 'succeeded'
          : transition === 'revoke'
            ? 'revoked'
            : 'recorded',
      outcomeDigest,
      errorCode: null,
    },
    audit.serviceHooks,
  );
  audit.onRecord?.(entry);
  return entry;
}

export function inspectExecutionBudgetGrantAuthorization(
  storeRoot: string,
  grantId: string,
): {
  envelope: ExecutionBudgetGrantEnvelope;
  payload: ExecutionBudgetGrantPayload;
  state: 'active' | 'consumed' | 'revoked';
  remainingUses: number;
  receipts: ExecutionBudgetConsumeReceipt[];
} {
  const paths = ensureExecutionBudgetGrantStore(storeRoot);
  const record = readGrantRecordRequired(
    path.join(paths.grants, `${assertUuid(grantId, invalidGrant)}.json`),
  );
  return {
    envelope: structuredClone(record.envelope),
    payload: structuredClone(record.envelope.payload),
    state: record.state,
    remainingUses: record.remainingUses,
    receipts: record.receipts.map((receipt) => ({ ...receipt })),
  };
}

/**
 * Enumerate every durably published execution-budget grant without creating
 * or repairing store state. Metrics include active, consumed, and revoked
 * grants, including grants that have never been consumed by an Attempt.
 */
export function listExecutionBudgetGrantMetrics(
  storeRoot: string,
): readonly ExecutionBudgetGrantMetricsRecord[] {
  if (typeof storeRoot !== 'string' || storeRoot.length < 1) {
    throw unsafeGrantStore();
  }
  const root = path.resolve(storeRoot);
  const grants = path.join(root, 'execution-budget-grants');
  const stats = fs.lstatSync(grants, { throwIfNoEntry: false });
  if (stats === undefined) return Object.freeze([]);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(grants) !== grants
  ) {
    throw unsafeGrantStore();
  }
  const records = fs
    .readdirSync(grants, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const match = entry.name.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/,
      );
      if (!entry.isFile() || entry.isSymbolicLink() || match === null) {
        throw unsafeGrantStore();
      }
      const grantId = match[1]!;
      const record = readGrantRecord(path.join(grants, entry.name));
      if (record.envelope.payload.grantId !== grantId) {
        throw unsafeGrantStore();
      }
      return {
        grantId,
        requestDigest: record.envelope.payload.requestDigest,
        consumedAttemptIds: [...record.consumedAttemptIds].sort(),
      };
    });
  return Object.freeze(
    records.map((record) =>
      Object.freeze({
        ...record,
        consumedAttemptIds: Object.freeze([...record.consumedAttemptIds]),
      }),
    ),
  );
}

function assertExecutionBudgetGrantAuditContext(
  value: unknown,
): ExecutionBudgetGrantAuditContext {
  if (
    !isRecord(value) ||
    typeof value.repositoryRoot !== 'string' ||
    !path.isAbsolute(value.repositoryRoot) ||
    path.normalize(value.repositoryRoot) !== value.repositoryRoot ||
    typeof value.repositoryIdentity !== 'string' ||
    value.repositoryIdentity.length < 1 ||
    (value.serviceHooks !== undefined && !isRecord(value.serviceHooks)) ||
    (value.actor !== undefined &&
      (!isRecord(value.actor) ||
        !hasExactKeys(value.actor, ['kind', 'identity']) ||
        !['agent', 'engine', 'human'].includes(String(value.actor.kind)) ||
        typeof value.actor.identity !== 'string' ||
        !IDENTITY.test(value.actor.identity))) ||
    (value.onRecord !== undefined && typeof value.onRecord !== 'function')
  ) {
    throw workflowError(
      'EXECUTION_BUDGET_GRANT_AUDIT_REQUIRED',
      'Execution-budget authority requires an exact repository audit context.',
      ExitCode.guard,
    );
  }
  return value as ExecutionBudgetGrantAuditContext;
}
