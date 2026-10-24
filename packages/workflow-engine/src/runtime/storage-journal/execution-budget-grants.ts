import { recordAuthorityRefusal } from './authority-refusal-audit.ts';
import {
  inspectionFromRecord,
  revokedInspectionFromRecord,
  requireAuditedExecutionBudgetGrant,
  requireCurrentExecutionBudgetGrantBinding,
  requireStoredExecutionBudgetGrantBinding,
  prepareExecutionBudgetGrantConsumption,
  prepareExecutionBudgetGrantRevocation,
} from '../../modules/authority/execution-governance.ts';
import type {
  ExecutionBudgetConsumeInput,
  ExecutionBudgetRevocationInput,
} from '../../modules/authority/execution-governance-grant-contracts.ts';
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
} from './authority-audit-ledger.ts';
import {
  type AuthorityAuditActor,
  type AuthorityAuditServiceHooks,
  type AuthorityAuditRecordedEvent,
  recordAuthorityAuditEvent,
} from './authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from '../../modules/authority/authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
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
} from '../../modules/authority/execution-governance-values.ts';
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
  type ExecutionBudgetConsumeReceipt,
  validateChanges,
  assertExecutionGrantMandateBinding,
  type ExecutionBudgetGrantInspection,
  type ExecutionBudgetGrantPayload,
  type ExecutionBudgetGrantMetricsRecord,
} from '../../modules/authority/execution-governance-grant-contracts.ts';
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
  const binding = requireAuditedExecutionBudgetGrant(
    envelope,
    {
      request: options?.request,
      mandateBinding: options?.mandateBinding,
      audit: options?.audit,
    },
    assertExecutionBudgetGrantAuditContext,
  );
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
  input: ExecutionBudgetConsumeInput & {
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
      recordAuthorityRefusal,
      refusalBinding,
      {
        now: new Date(consumedAt),
        serviceHooks: audit.serviceHooks,
        onRecord: audit.onRecord,
      },
      () => {
        const { binding, receipt, next } =
          prepareExecutionBudgetGrantConsumption(
            record,
            payload,
            input,
            grantId,
            consumedAt,
            inputBinding,
          );
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
  input: ExecutionBudgetRevocationInput & {
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
      recordAuthorityRefusal,
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
        const revoked = prepareExecutionBudgetGrantRevocation(
          record,
          input,
          grantId,
          revokedAt,
        );
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
